#!/usr/bin/env bash
# extract-node8-payload.sh — build the production Node/Tessel runtime payload for
# the 25.12 image using a SOFT-FLOAT node 8.11.3 cross-built in the in-ladder
# OpenWrt 19.07 tree, then LIFTED onto the 25.12 (k6.12/musl) rootfs.
#
# WHY THIS EXISTS (supersedes extract-node-payload.sh, the 4.2.1/uClibc lift)
# -------------------------------------------------------------------------
# The factory node 4.2.1 lift booted but SIGILL'd on-device: it is an o32
# HARD-FLOAT FP32 binary with no .MIPS.abiflags, and the 24KEc has no FPU, so the
# 6.12 kernel does not emulate its cp1 ops -> illegal instruction on first FP op.
# The clean fix is a SOFT-FLOAT node (zero cp1 instructions). Node 8's bundled
# V8 6.2 cannot build on the 25.12 gcc-14 toolchain, but it builds cleanly in the
# 19.07 tree (gcc-7.5.0 + musl). musl keeps a stable forward ABI, and both trees
# use the SAME loader soname ld-musl-mipsel-sf.so.1, so a 19.07-built node runs on
# the 25.12 musl rootfs unchanged.
#
# node 8.11.3 is produced by DOWNGRADING the 19.07 packages feed node pkg
# (feeds/packages/lang/node, shipped v8.16.1) to PKG_VERSION=v8.11.3 — reusing its
# proven gcc-7.5/musl patch set. That feed pkg links SHARED, so node NEEDs a 9-lib
# closure. Unlike the uClibc lift, the loader soname here is IDENTICAL to 25.12's
# system loader, so we must NOT ship a loader into /lib (it would clobber the
# system musl and brick every binary). Instead:
#   * node uses the 25.12 SYSTEM loader /lib/ld-musl-mipsel-sf.so.1 (musl is
#     forward-ABI-compatible; NEEDED libc.so is satisfied by the loader itself,
#     whose DT_SONAME is libc.so).
#   * the other 8 NEEDED libs (libz, libhttp_parser, libuv, libnghttp2,
#     libcrypto.so.1.1, libssl.so.1.1, libstdc++.so.6, libgcc_s.so.1) + their
#     transitive deps (minus libc) live in /opt/tessel/lib, isolated by a
#     /usr/bin/node wrapper that sets LD_LIBRARY_PATH=/opt/tessel/lib. This keeps
#     openssl 1.1 from clashing with 25.12's openssl 3 (libcrypto.so.3) and keeps
#     the 19.07 libstdc++/libz from touching the stock rootfs copies.
#   * the wrapper also sets NODE_PATH=/usr/lib/node so require('tessel') resolves
#     the runtime (node derives its legacy global dir from execPath).
#
# LAYOUT laid down (rootfs-rooted tar consumed by build.sh TESSEL_PROD=1):
#   /opt/tessel/bin/node                 stripped soft-float node 8.11.3 (from .ipk)
#   /opt/tessel/lib/*.so*                the 8-lib soft-float closure (NO libc, NO loader)
#   /usr/bin/node                        wrapper (LD_LIBRARY_PATH + NODE_PATH)
#   /usr/lib/node/{tessel,tessel-export}.js     node-8 runtime (t2-firmware a22ba2d2)
#   /opt/tessel/lib/node/{tessel,tessel-export}.js  dup for the execPath-derived path
#
# USAGE (inside the build container):
#   docker compose run --rm --entrypoint bash build -lc "bash /artifacts/extract-node8-payload.sh"
# Inputs:
#   * a built 19.07 tree with node 8.11.3 (TREE, default /work/openwrt-v19.07.10)
#   * the node-8 JS at $JSDIR (default /artifacts/node8-js/{tessel,tessel-export}.js)
# Output: $OUT (default /artifacts/tessel-node8-payload.tar.gz)
set -euo pipefail

TREE="${TREE:-/work/openwrt-v19.07.10}"
JSDIR="${JSDIR:-/artifacts/node8-js}"
OUT="${OUT:-/artifacts/tessel-node8-payload.tar.gz}"
WORK="${WORK:-/work/prod-node8}"

RE="$(ls "$TREE"/staging_dir/toolchain-*/bin/mipsel-openwrt-linux-readelf 2>/dev/null | head -1)"
STRIP="$(ls "$TREE"/staging_dir/toolchain-*/bin/mipsel-openwrt-linux-strip 2>/dev/null | head -1)"
[[ -x "$RE" ]] || { echo "ERROR: target readelf not found under $TREE" >&2; exit 1; }
[[ -x "$STRIP" ]] || { echo "ERROR: target strip not found under $TREE" >&2; exit 1; }
[[ -f "$JSDIR/tessel-export.js" && -f "$JSDIR/tessel.js" ]] || {
  echo "ERROR: node-8 JS missing under $JSDIR (need tessel.js + tessel-export.js)" >&2; exit 1; }

# Source the UNSTRIPPED staged node (keeps .MIPS.abiflags); OpenWrt's packaged .ipk
# is sstripped and DROPS .MIPS.abiflags, which we need so (a) `readelf -A` can prove
# Soft float and (b) the kernel selects the soft-float FP mode. binutils strip
# preserves .MIPS.abiflags (SHF_ALLOC) while removing debug info.
NODE_SRC="$(ls "$TREE"/staging_dir/target-*/root-ramips/usr/bin/node 2>/dev/null | head -1)"
[[ -f "$NODE_SRC" ]] || { echo "ERROR: staged node not found (build node first)" >&2; exit 1; }

needed()  { "$RE" -d "$1" 2>/dev/null | awk '/NEEDED/{gsub(/[][]/,"",$5); print $5}'; }
# search paths for the soft-float closure: target rootfs staging + toolchain libs
SDIRS=$(printf '%s\n' "$TREE"/staging_dir/target-*/root-ramips/lib \
                      "$TREE"/staging_dir/target-*/root-ramips/usr/lib \
                      "$TREE"/staging_dir/target-*/usr/lib \
                      "$TREE"/staging_dir/toolchain-*/lib \
                      "$TREE"/staging_dir/toolchain-*/usr/lib 2>/dev/null)
find_lib() { for d in $SDIRS; do p="$d/$1"; [[ -e "$p" ]] && { readlink -f "$p"; return; }; done; }

echo "==> stripping the staged node (preserving .MIPS.abiflags)"
rm -rf "$WORK"; mkdir -p "$WORK"
OUTD="$WORK/opt/tessel"; mkdir -p "$OUTD/bin" "$OUTD/lib"
cp "$NODE_SRC" "$OUTD/bin/node"
"$STRIP" --strip-all "$OUTD/bin/node"
echo "    node: $(stat -c%s "$NODE_SRC") -> $(stat -c%s "$OUTD/bin/node") bytes (stripped)"
# Assert soft-float survived the strip (the property that dodges the 4.2.1 SIGILL).
FPABI="$("$RE" -A "$OUTD/bin/node" 2>/dev/null | awk -F': ' '/FP ABI/{print $2}')"
echo "    FP ABI = ${FPABI:-<none>}; interp = $("$RE" -l "$OUTD/bin/node" 2>/dev/null | awk -F': ' '/interpreter/{gsub(/].*/,"",$2);print $2}')"
[[ "$FPABI" == "Soft float" ]] || { echo "ERROR: node is NOT soft-float ($FPABI) — aborting" >&2; exit 1; }

echo "==> resolving transitive closure (excluding libc.so + the musl loader)"
declare -A seen
# libc.so is satisfied by the system loader (DT_SONAME=libc.so) -> never ship it.
seen["libc.so"]=1
queue="$(needed "$OUTD/bin/node")"; missing=""
while [[ -n "${queue// }" ]]; do
  nq=""
  for so in $queue; do
    [[ -n "${seen[$so]:-}" ]] && continue; seen[$so]=1
    real="$(find_lib "$so")"; [[ -z "$real" ]] && { missing="$missing $so"; continue; }
    cp -L "$real" "$OUTD/lib/$so"
    fp="$("$RE" -A "$OUTD/lib/$so" 2>/dev/null | grep -i 'FP ABI' | sed 's/.*: //')"
    echo "    + $so  [$fp]"
    nq="$nq $(needed "$OUTD/lib/$so")"
  done
  queue="$nq"
done
[[ -z "${missing// }" ]] || { echo "ERROR: unresolved libs:$missing" >&2; exit 1; }
echo "    closure complete ($(ls "$OUTD/lib" | wc -l) libs, libc/loader excluded)"

echo "==> assembling rootfs-rooted payload tree"
PZ="$WORK/payload"; rm -rf "$PZ"
mkdir -p "$PZ/opt/tessel/bin" "$PZ/opt/tessel/lib/node" "$PZ/usr/bin" "$PZ/usr/lib/node"
cp "$OUTD/bin/node" "$PZ/opt/tessel/bin/node"
cp -a "$OUTD/lib/." "$PZ/opt/tessel/lib/"
cp "$JSDIR/tessel.js"        "$PZ/usr/lib/node/tessel.js"
cp "$JSDIR/tessel-export.js" "$PZ/usr/lib/node/tessel-export.js"
cp "$JSDIR/tessel.js"        "$PZ/opt/tessel/lib/node/tessel.js"
cp "$JSDIR/tessel-export.js" "$PZ/opt/tessel/lib/node/tessel-export.js"
cat > "$PZ/usr/bin/node" <<'WRAP'
#!/bin/sh
# Soft-float node 8.11.3 (built in the 19.07 musl tree, lifted onto 25.12).
# LD_LIBRARY_PATH puts the 19.07 closure (incl. openssl 1.1, libstdc++/libz)
# ahead of the stock 25.12 libs, so node's deps resolve to the matched soft-float
# copies and openssl 1.1 never clashes with 25.12's openssl 3. libc + the loader
# are the SYSTEM musl (/lib/ld-musl-mipsel-sf.so.1) -> forward-ABI-compatible.
# NODE_PATH pins the tessel runtime (node's execPath-derived global dir would
# otherwise miss /usr/lib/node/tessel.js).
exec env LD_LIBRARY_PATH="/opt/tessel/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
         NODE_PATH="/usr/lib/node${NODE_PATH:+:$NODE_PATH}" \
         /opt/tessel/bin/node "$@"
WRAP
chmod 0755 "$PZ/usr/bin/node" "$PZ/opt/tessel/bin/node"

echo "==> writing $OUT"
tar czpf "$OUT" -C "$PZ" .
echo "    $(stat -c%s "$OUT") bytes"; sha256sum "$OUT"
echo "==> payload contents:"; tar tzf "$OUT" | sed 's/^/      /'
