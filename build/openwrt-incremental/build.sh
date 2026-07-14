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

  # Add a Device/tessel profile to the mt7620 image Makefile (idempotent).
  local mk="$SRC/target/linux/ramips/image/mt7620.mk"
  if ! grep -q "Device/tessel" "$mk"; then
    cat >> "$mk" <<'EOF'

define Device/tessel
  DTS := Tessel
  IMAGE_SIZE := $(ralink_default_fw_size_32M)
  DEVICE_TITLE := Tessel 2
  DEVICE_PACKAGES := tessel-tools kmod-spi-dev kmod-usb2 kmod-usb-ohci
endef
TARGET_DEVICES += tessel
EOF
    echo "    added Device/tessel to mt7620.mk"
  fi

  # Feeds + minimal config seed.
  cd "$SRC"
  [[ -f feeds.conf.default ]] && cp feeds.conf.default feeds.conf || true
  ./scripts/feeds update -a
  ./scripts/feeds install -a

  cp "$OVERLAY/config.seed" "$SRC/.config"
  make defconfig
  echo "==> Effective device selection:"
  grep -E "DEVICE_tessel|PACKAGE_tessel-tools|PACKAGE_kmod-spi-dev" "$SRC/.config" || true
}

build_world() {
  echo "==> Building host tools + world (jobs=$BUILD_JOBS) ..."
  cd "$SRC"
  # Fetch first so download failures surface clearly.
  make -j"$BUILD_JOBS" download V=s || true
  make -j"$BUILD_JOBS" || make -j1 V=s
}

copy_artifacts() {
  echo "==> Copying artifacts ..."
  mkdir -p /artifacts
  find "$SRC/bin" -name "*tessel*sysupgrade.bin" -exec cp {} /artifacts/ \; 2>/dev/null || true
  find "$SRC/bin" -name "*tessel*" -name "*.bin" -exec cp {} /artifacts/ \; 2>/dev/null || true
  echo "==> /artifacts:"; ls -lh /artifacts/ || true
}

case "${1:-build}" in
  build)   clone_sources; apply_overlay; build_world; copy_artifacts ;;
  prepare) clone_sources; apply_overlay ;;
  world)   build_world; copy_artifacts ;;
  shell)   clone_sources; cd "$SRC" 2>/dev/null || cd "$WORK"; exec bash ;;
  *) echo "usage: build.sh [build|prepare|world|shell]"; exit 1 ;;
esac
