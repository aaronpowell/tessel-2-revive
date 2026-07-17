#!/usr/bin/env bash
# build.sh — clean-upstream OpenWrt build + thin Tessel overlay.
#
# Clones a stock upstream OpenWrt release (OPENWRT_TAG), drops in the Tessel board
# DTS, the tessel-tools package, and a minimal config, then builds a Tessel
# sysupgrade image. Runs inside the Ubuntu 18.04 container.

set -euo pipefail

OPENWRT_TAG="${OPENWRT_TAG:-v17.01.7}"
BUILD_JOBS="${BUILD_JOBS:-$(nproc)}"
WORK=/work
SRC="$WORK/openwrt-$OPENWRT_TAG"
OVERLAY=/overlay

# Archived infra (git.lede-project.org, old downloads mirrors) often has expired
# certs. This is a throwaway container fetching archived open-source; tolerate it.
export GIT_SSL_NO_VERIFY=1
git config --global http.sslVerify false || true
echo "check_certificate = off" > /root/.wgetrc

# Map an OpenWrt release tag to the matching GitHub feed mirror branch.
feed_branch() {
  case "$OPENWRT_TAG" in
    v17.01.*) echo "lede-17.01" ;;
    v18.06.*) echo "openwrt-18.06" ;;
    v19.07.*) echo "openwrt-19.07" ;;
    v21.02.*) echo "openwrt-21.02" ;;
    v22.03.*) echo "openwrt-22.03" ;;
    v23.05.*) echo "openwrt-23.05" ;;
    v24.10.*) echo "openwrt-24.10" ;;
    v25.12.*) echo "openwrt-25.12" ;;
    *)        echo "master" ;;
  esac
}

# Map an OpenWrt release tag to its ramips kernel patches dir (per kernel version).
# Kept separate so a kernel-version-specific patch never leaks into another hop.
kernel_patch_dir() {
  case "$OPENWRT_TAG" in
    v17.01.*)          echo "patches-4.4" ;;
    v18.06.*|v19.07.*) echo "patches-4.14" ;;
    v21.02.*)          echo "patches-5.4" ;;
    v22.03.*)          echo "patches-5.10" ;;
    v23.05.*)          echo "patches-5.15" ;;
    v24.10.*)          echo "patches-6.6" ;;
    v25.12.*)          echo "patches-6.12" ;;
    *)                 echo "" ;;
  esac
}

clone_sources() {
  if [[ ! -d "$SRC/.git" ]]; then
    echo "==> Cloning upstream OpenWrt $OPENWRT_TAG ..."
    git clone --depth=1 --branch "$OPENWRT_TAG" \
      https://github.com/openwrt/openwrt.git "$SRC"
  fi
}

apply_overlay() {
  echo "==> Applying Tessel overlay ..."
  # Board DTS
  cp "$OVERLAY/dts/Tessel.dts" "$SRC/target/linux/ramips/dts/Tessel.dts"

  # tessel-tools package
  rm -rf "$SRC/package/tessel-tools"
  cp -r "$OVERLAY/tessel-tools" "$SRC/package/tessel-tools"

  # Tessel-specific kernel patches (e.g. the mt7620 spi_cs1 pinmux). Copied into
  # the ramips patches dir matching this release's kernel version; OpenWrt applies
  # them (numeric order, after upstream patches) during the kernel prepare step.
  local kpd; kpd="$(kernel_patch_dir)"
  if [[ -n "$kpd" && -d "$OVERLAY/patches/ramips/$kpd" ]]; then
    echo "==> Installing Tessel ramips kernel patches into target/linux/ramips/$kpd ..."
    mkdir -p "$SRC/target/linux/ramips/$kpd"
    cp "$OVERLAY/patches/ramips/$kpd/"*.patch "$SRC/target/linux/ramips/$kpd/"
    ls "$SRC/target/linux/ramips/$kpd/"9*-tessel-*.patch 2>/dev/null || true
  fi

  # spidev DT-binding whitelist (kernel 5.15+). At k5.15 drivers/spi/spidev.c
  # gained spidev_of_check(), which HARD-FAILS (-EINVAL, "spidev listed directly
  # in DT is not supported") any node whose compatible is literally "spidev", and
  # the of_match table now lists only real parts. So the bare compatible="spidev"
  # that binds on <=k5.10 (via modalias=="spidev") no longer creates
  # /dev/spidevX.Y -> spid can't open the coprocessor -> bridge down. Fix: use a
  # whitelisted compatible ("rohm,dh2228fv") that spidev accepts; the /dev node
  # name (spidevBUS.CS) is unchanged so spid and spid.sh args are untouched.
  #
  # This is VERSION-GATED, not a static swap: spidev_of_check matches "spidev"
  # ANYWHERE in the compatible list (so dual-listing "rohm,dh2228fv","spidev"
  # still trips the 5.15 hard-fail), while the validated <=k5.10 hops bind spidev
  # via modalias=="spidev" and need the bare "spidev". No single string works on
  # both sides, so we rewrite the copied DTS for k5.15+ only.
  if [[ -n "$kpd" ]]; then
    local kv="${kpd#patches-}"          # patches-5.15 -> 5.15
    local kmaj="${kv%%.*}" kmin="${kv#*.}"
    if (( kmaj * 1000 + kmin >= 5015 )); then
      sed -i '/^[[:space:]]*compatible = "spidev";/s/"spidev"/"rohm,dh2228fv"/' \
        "$SRC/target/linux/ramips/dts/Tessel.dts"
      echo "    k$kv >= 5.15: coprocessor compatible spidev -> rohm,dh2228fv (spidev whitelist)"
    fi
  fi

  # Ensure name-based firmware mtdsplit is enabled. 18.06's mt7620 defconfig set
  # CONFIG_MTD_SPLIT_FIRMWARE=y; 19.07 dropped it. Without it the kernel never
  # splits the bare "firmware"-labelled partition into kernel+rootfs (the split
  # fires only for a partition named "firmware" that has NO `compatible`), so
  # there is no rootfs mtd, no root=, and the board panics "unable to mount root
  # fs" at boot. It is a KERNEL config symbol (lives in the target kernel config
  # fragment, not the top-level OpenWrt .config), so it must be injected here —
  # a seed entry is silently dropped by `make defconfig`.
  if [[ -n "$kpd" ]]; then
    local kver="${kpd#patches-}"          # patches-4.14 -> 4.14
    local kcfg
    for kcfg in "$SRC/target/linux/ramips/mt7620/config-$kver" \
                "$SRC/target/linux/ramips/config-$kver"; do
      if [[ -f "$kcfg" ]]; then
        sed -i '/CONFIG_MTD_SPLIT_FIRMWARE[ =]/d' "$kcfg"
        echo "CONFIG_MTD_SPLIT_FIRMWARE=y" >> "$kcfg"
        echo "    ensured CONFIG_MTD_SPLIT_FIRMWARE=y in ${kcfg#$SRC/}"
        break
      fi
    done
  fi

  # Add a Device/tessel profile to the mt7620 image Makefile (idempotent).
  #
  # 21.02 (k5.4) rewrote the ramips image-recipe conventions: the old `DTS :=`
  # and `DEVICE_TITLE :=` variables were dropped, DTS filenames became
  # SOC-prefixed, and Device/Default now defaults `DEVICE_DTS = $$(SOC)_$(1)`
  # (device name). A pre-21.02-style block therefore resolves DEVICE_DTS to
  # `_tessel` (empty SOC) and the build fails looking for `../dts/_tessel.dts`.
  # Detect the new convention from the tree and emit the matching block; we keep
  # our single overlay `Tessel.dts` by setting DEVICE_DTS explicitly.
  local mk="$SRC/target/linux/ramips/image/mt7620.mk"
  if ! grep -q "Device/tessel" "$mk"; then
    if grep -qs 'DEVICE_DTS = \$\$(SOC)_' "$SRC/target/linux/ramips/image/Makefile"; then
      echo "    (21.02+ image-recipe convention detected: SOC/DEVICE_DTS/VENDOR+MODEL)"
      cat >> "$mk" <<'EOF'

define Device/tessel
  SOC := mt7620n
  DEVICE_DTS := Tessel
  IMAGE_SIZE := 32448k
  DEVICE_VENDOR := Tessel
  DEVICE_MODEL := Tessel 2
  SUPPORTED_DEVICES := tessel,tessel2 tessel tessel2
  DEVICE_PACKAGES := tessel-tools kmod-spi-dev kmod-usb2 kmod-usb-ohci
endef
TARGET_DEVICES += tessel
EOF
    else
      cat >> "$mk" <<'EOF'

define Device/tessel
  DTS := Tessel
  IMAGE_SIZE := $(ralink_default_fw_size_32M)
  DEVICE_TITLE := Tessel 2
  SUPPORTED_DEVICES := tessel,tessel2 tessel tessel2
  DEVICE_PACKAGES := tessel-tools kmod-spi-dev kmod-usb2 kmod-usb-ohci
endef
TARGET_DEVICES += tessel
EOF
    fi
    echo "    added Device/tessel to mt7620.mk"
  fi

  # The 2017-era default download mirrors are dead. Prefer the live OpenWrt sources
  # archive (flat, by filename) for every source tarball (gcc, musl, ...).
  cat > "$SRC/scripts/localmirrors" <<'EOF'
https://sources.openwrt.org
https://sources.cdn.openwrt.org
https://mirror2.openwrt.org/sources
EOF

  # Feeds: rewrite to reliable GitHub mirrors (default infra is often dead), and
  # treat failures as non-fatal — the minimal bridge image is core-tree only.
  cd "$SRC"
  local fb; fb="$(feed_branch)"
  cat > feeds.conf <<EOF
src-git packages https://github.com/openwrt/packages.git;$fb
src-git luci https://github.com/openwrt/luci.git;$fb
src-git routing https://github.com/openwrt/routing.git;$fb
src-git telephony https://github.com/openwrt/telephony.git;$fb
EOF
  echo "==> Updating feeds (branch $fb; non-fatal) ..."
  ./scripts/feeds update -a || echo "    (feeds update partial/failed — continuing, minimal image is core-only)"
  ./scripts/feeds install -a || true

  # Optional diagnostic rootfs files (baked into the image via OpenWrt's files/
  # mechanism). Gated behind TESSEL_DIAG so the normal validation image stays
  # clean. Always start from a clean files/ so rebuilds are deterministic.
  rm -rf "$SRC/files"
  if [[ "${TESSEL_DIAG:-0}" == "1" && -d "$OVERLAY/files" ]]; then
    echo "==> TESSEL_DIAG=1: baking diagnostic files/ overlay (Wi-Fi AP) ..."
    mkdir -p "$SRC/files"
    cp -a "$OVERLAY/files/." "$SRC/files/"
    chmod 0755 "$SRC/files/etc/uci-defaults/"* 2>/dev/null || true
  fi
  # Initramfs boot-diagnostic overlay: an auto-running mtd5 read/mount probe. Baked
  # only for the RAM-root initramfs image so its output prints on the boot console.
  if [[ "${TESSEL_INITRAMFS:-0}" == "1" && -d "$OVERLAY/initramfs-diag" ]]; then
    echo "==> TESSEL_INITRAMFS=1: baking mtd5 root-mount probe overlay ..."
    mkdir -p "$SRC/files"
    cp -a "$OVERLAY/initramfs-diag/." "$SRC/files/"
    chmod 0755 "$SRC/files/etc/uci-defaults/"* 2>/dev/null || true
  fi

  cp "$OVERLAY/config.seed" "$SRC/.config"
  # Optional: additionally emit an initramfs (RAM-root) kernel for boot diagnostics.
  # With this on, OpenWrt builds a *-initramfs-kernel.bin whose root filesystem is
  # embedded in the kernel and unpacked into RAM, so the board boots to a shell
  # WITHOUT mounting the on-flash rootfs. That lets a broken on-flash root mount
  # (e.g. the 24.10 squashfs-on-mtd5 non-boot) be probed live from a shell. The
  # squashfs sysupgrade image is still built alongside, so its rootfs can be
  # appended to the initramfs kernel to reproduce the exact mtd5 geometry.
  # Gated behind TESSEL_INITRAMFS so normal validation images stay unchanged.
  if [[ "${TESSEL_INITRAMFS:-0}" == "1" ]]; then
    echo "==> TESSEL_INITRAMFS=1: enabling CONFIG_TARGET_ROOTFS_INITRAMFS=y"
    sed -i '/CONFIG_TARGET_ROOTFS_INITRAMFS[ =]/d' "$SRC/.config"
    echo "CONFIG_TARGET_ROOTFS_INITRAMFS=y" >> "$SRC/.config"
  fi
  make defconfig
  echo "==> Effective device selection:"
  grep -E "DEVICE_tessel|PACKAGE_tessel-tools|PACKAGE_kmod-spi-dev" "$SRC/.config" || true
}

build_world() {
  echo "==> Building host tools + world (jobs=$BUILD_JOBS) ..."
  cd "$SRC"
  export DOWNLOAD_MIRROR="https://sources.openwrt.org;https://sources.cdn.openwrt.org"
  # Container runs as root; several host tools (tar, etc.) refuse to configure as root.
  export FORCE_UNSAFE_CONFIGURE=1
  # Fetch first so download failures surface clearly.
  make -j"$BUILD_JOBS" download V=s || true
  make -j"$BUILD_JOBS" || make -j1 V=s
}

copy_artifacts() {
  echo "==> Copying artifacts ..."
  mkdir -p /artifacts
  local suffix=""
  [[ "${TESSEL_DIAG:-0}" == "1" ]] && suffix="-DIAG"
  find "$SRC/bin" -name "*tessel*sysupgrade.bin" | while read -r f; do
    local base; base="$(basename "$f" .bin)"
    cp "$f" "/artifacts/${base}${suffix}.bin"
  done
  # Also copy any other tessel .bin (e.g. initramfs) unmodified for completeness.
  find "$SRC/bin" -name "*tessel*" -name "*.bin" ! -name "*sysupgrade.bin" \
    -exec cp {} /artifacts/ \; 2>/dev/null || true
  echo "==> /artifacts:"; ls -lh /artifacts/ || true
}

case "${1:-build}" in
  build)   clone_sources; apply_overlay; build_world; copy_artifacts ;;
  prepare) clone_sources; apply_overlay ;;
  world)   build_world; copy_artifacts ;;
  shell)   clone_sources; cd "$SRC" 2>/dev/null || cd "$WORK"; exec bash ;;
  *) echo "usage: build.sh [build|prepare|world|shell]"; exit 1 ;;
esac
