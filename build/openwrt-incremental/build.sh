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
    *)        echo "master" ;;
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

  cp "$OVERLAY/config.seed" "$SRC/.config"
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
