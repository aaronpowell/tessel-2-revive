#!/usr/bin/env bash
# Build the release artifacts that t2-cli downloads, from a sysupgrade image.
#
# Produces two tarballs whose *member names* are what the CLI looks for:
#
#   tessel-restore.tar.gz   consumed by `t2 restore` (lib/update-fetch.js
#                           fetchRestore -> RESTORE_UBOOT_FILE + RESTORE_SQUASHFS_FILE).
#                           Full recovery: rewrites u-boot, a fresh factory partition
#                           and the rootfs over USB/DFU.
#
#   tessel-update.tar.gz    consumed by `t2 update` (fetchBuild -> openwrt.bin and,
#                           optionally, firmware.bin). Plain sysupgrade of the OpenWrt
#                           image only.
#
# Why no firmware.bin by default: firmware.bin is the SAMD21 coprocessor image, and
# this project has never rebuilt it -- the factory coprocessor firmware is what every
# board runs and it works. Shipping the archive without it means `t2 update` skips the
# coprocessor step entirely, which also avoids the bootloader handoff that has
# historically been the least reliable part of the update path. Pass --firmware to
# include one anyway.
#
# The stable output names matter: lib/remote.js defaults `t2 restore` to
#   https://github.com/<repo>/releases/latest/download/tessel-restore.tar.gz
# so every release must publish that exact asset name for the default to keep working.
set -euo pipefail

UBOOT_MEMBER="openwrt-ramips-mt7620-Default-u-boot.bin"
SQUASHFS_MEMBER="openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin"

image=""
uboot=""
firmware=""
outdir="."

usage() {
  cat >&2 <<USAGE
usage: $0 --image <sysupgrade.bin> --uboot <u-boot.bin> [--firmware <firmware.bin>] [--outdir <dir>]

  --image     the *-squashfs-sysupgrade.bin produced by build.sh
  --uboot     u-boot image (reuse the factory one; this project does not rebuild it)
  --firmware  optional SAMD21 coprocessor image to include in the update archive
  --outdir    where to write the tarballs (default: .)
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image)    image="${2:-}"; shift 2 ;;
    --uboot)    uboot="${2:-}"; shift 2 ;;
    --firmware) firmware="${2:-}"; shift 2 ;;
    --outdir)   outdir="${2:-}"; shift 2 ;;
    -h|--help)  usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$image" ] && [ -n "$uboot" ] || usage
[ -f "$image" ] || { echo "no such image: $image" >&2; exit 1; }
[ -f "$uboot" ] || { echo "no such u-boot: $uboot" >&2; exit 1; }
[ -z "$firmware" ] || [ -f "$firmware" ] || { echo "no such firmware: $firmware" >&2; exit 1; }

# Sanity-check the image really is a flashable uImage (magic 27 05 19 56 at offset 0)
# rather than an initramfs/RAM-root kernel or a truncated download.
magic=$(od -An -tx1 -N4 "$image" | tr -d ' \n')
if [ "$magic" != "27051956" ]; then
  echo "ERROR: $image does not start with the uImage magic 27051956 (got $magic)." >&2
  echo "       Refusing to package a non-flashable image." >&2
  exit 1
fi

mkdir -p "$outdir"
outdir=$(cd "$outdir" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# --- restore archive -------------------------------------------------------------
# u-boot is added first to match the order used by the bundles we have flashed and
# hardware-validated.
mkdir -p "$stage/restore"
cp "$uboot" "$stage/restore/$UBOOT_MEMBER"
cp "$image" "$stage/restore/$SQUASHFS_MEMBER"
tar -czf "$outdir/tessel-restore.tar.gz" \
  -C "$stage/restore" "$UBOOT_MEMBER" "$SQUASHFS_MEMBER"

# --- update archive --------------------------------------------------------------
mkdir -p "$stage/update"
cp "$image" "$stage/update/openwrt.bin"
members="openwrt.bin"
if [ -n "$firmware" ]; then
  cp "$firmware" "$stage/update/firmware.bin"
  members="$members firmware.bin"
fi
# shellcheck disable=SC2086
tar -czf "$outdir/tessel-update.tar.gz" -C "$stage/update" $members

echo "wrote:"
for f in "$outdir/tessel-restore.tar.gz" "$outdir/tessel-update.tar.gz"; do
  printf '  %s  %s bytes  sha256=%s\n' \
    "$f" "$(wc -c < "$f" | tr -d ' ')" "$(sha256sum "$f" | cut -d' ' -f1)"
done
echo "members:"
tar -tzf "$outdir/tessel-restore.tar.gz" | sed 's/^/  restore: /'
tar -tzf "$outdir/tessel-update.tar.gz" | sed 's/^/  update:  /'
