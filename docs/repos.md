# Repository Inventory

All repos are forked from the `tessel` GitHub organisation into `aaronpowell` and included as submodules in this repo under `repos/`.

Each entry lists:
- **Fork** — the active fork URL
- **Upstream** — original Tessel repo
- **Branch** — active working branch
- **What changed** — summary of revival work done
- **Status** — current state

---

## Core repos

### t2-cli
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/t2-cli |
| **Upstream** | https://github.com/tessel/t2-cli |
| **Branch** | `master` |
| **Local path** | `repos/t2-cli` |

The primary user-facing tool. All `t2 <command>` invocations go through here.

**What changed:**
- Replaced all references to dead Tessel infrastructure (`builds.tessel.io`, `rustcc.tessel.io`, `crash-reporter.tessel.io`) with configurable GitHub-based artifact URLs
- Fixed Node 24+ / modern stream compatibility issue in `usb-connection.js`
- Made crash reporter non-blocking when unconfigured (prevents noise in tests)
- Removed obsolete `npm rebuild --update-binary` flag from postinstall
- Updated postinstall script so it no longer requires `t2` to be globally linked before `npm install` completes
- Seeded `resources/releases/builds.json` with the initial fork manifest entry (version `0.0.18`, OpenWrt SHA `c61b3d8...`)
- Added `.github/workflows/validate-release-manifest.yml` to keep manifest consistent
- Updated README with WSL2 setup instructions and GitHub artifact layout documentation
- Updated stale issue/repo URLs

**Artifact configuration (environment variables):**
```
T2_BUILDS_JSON_URL   — manifest URL  (default: raw GitHub master branch builds.json)
T2_BUILDS_BASE_URL   — release asset base URL  (default: aaronpowell/t2-cli GitHub Releases)
T2_FACTORY_URL       — restore/factory tarball URL
T2_RESTORE_URL       — restore/factory tarball URL (used by current t2-cli code)
```

Known archived fallback for restore image:
`https://web.archive.org/web/20201102173433/https://s3.amazonaws.com/builds.tessel.io/custom/new_build_next.tar.gz`

---

### t2-firmware
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/t2-firmware |
| **Upstream** | https://github.com/tessel/t2-firmware |
| **Branch** | `master` |
| **Local path** | `repos/t2-firmware` |

Contains:
- SAMD21 coprocessor firmware (`firmware/`)
- SoC daemons: `spid`, `usbexecd` (`soc/`)
- Node.js hardware shim (`node/tessel.js`, `node/tessel-export.js`)
- DFU bootloader (`boot/`)

**What changed:**
- Updated `deps/usb` submodule: changed bare `enum` to `typedef enum` in `usb_standard.h` to fix implicit function declaration errors under modern GCC

**Build output:**
```
t2-firmware/build/firmware.bin   — SAMD21 coprocessor firmware
t2-firmware/build/boot.bin       — DFU bootloader
```

**Build requirements:** `gcc-arm-none-eabi`, `make`

---

### t2-build
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/t2-build |
| **Upstream** | https://github.com/tessel/t2-build |
| **Branch** | `master` |
| **Local path** | `repos/t2-build` |

Build tooling and scripts for producing Tessel release images.

**What changed:**
- Added `docker/openwrt-bionic/Dockerfile` — Ubuntu 18.04 container with Python 2, bundled cmake 2.8.12.2, and all legacy build dependencies
- Added `openwrt-env.sh` wrapper script with commands: `build-image`, `host-tools`, `world`, `shell`, `exec`, `fix-perms`
- Updated README with the preferred containerised build flow

**To build an OpenWrt image:**
```bash
cd repos/t2-build
./openwrt-env.sh build-image   # build the Docker image once
./openwrt-env.sh host-tools    # build fragile host tools inside container
./openwrt-env.sh world         # full OpenWrt world build
```
Output lands in `../openwrt/bin/ramips/`.

---

### t2-release
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/t2-release |
| **Upstream** | https://github.com/tessel/t2-release |
| **Branch** | `master` |
| **Local path** | `repos/t2-release` |

Tooling for assembling and publishing release artifacts.

**What changed:**
- Reworked from a Tessel-infrastructure publisher into a GitHub-native release/manifest tool
- Generates `builds.json` manifest pointing to `aaronpowell/t2-cli` GitHub Releases assets
- Added local dry-run / assembly flow (no GitHub credentials required for testing)
- Added test suite (`tests/release.test.js`)
- Updated README

**GitHub asset layout expected by t2-cli:**
```
aaronpowell/t2-cli GitHub Releases:
  Tag: builds
    → builds/<sha>.tar.gz          (OpenWrt + firmware bundle)
    → factory/new_build_next.tar.gz (restore/factory image)

aaronpowell/t2-cli repository:
  Branch: master
    → resources/releases/builds.json  (manifest, fetched by update command)
```

---

### openwrt-tessel
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/openwrt-tessel |
| **Upstream** | https://github.com/tessel/openwrt-tessel |
| **Branch** | `master` |
| **Local path** | `repos/openwrt-tessel` |

OpenWrt overlay and build scripts; defines Tessel-specific packages, configs, and the board target. This is the outermost wrapper — it includes `openwrt` as a submodule.

**What changed:** None directly; build fixes are in the `openwrt` submodule.

---

### openwrt
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/openwrt |
| **Upstream** | https://github.com/tessel/openwrt |
| **Branch** | `2018-07-13` |
| **Local path** | `repos/openwrt` |

Custom OpenWrt fork for the MT7620 target. This is a heavily aged snapshot (Barrier Breaker era, ~2014 base) with Tessel-specific patches on top.

**What changed:**
- Fixed dead/legacy `git://` source fetch URLs for: `hostapd`, `usign`, `odhcpd`, `libubox`, `firewall`, `netifd`, `iwinfo`, `procd`, `ubox`, `ubus`, `uci`, `jsonfilter`
- Fixed `libpcap` packaging/install failure
- `tools/m4`: added `patches/110-glibc-change-work-around.patch` and `patches/120-c-stack-stop-using-sigstksz.patch` for modern glibc
- `tools/make-ext4fs`: added `patches/100-include-sysmacros.patch` for modern kernel headers

**Build output:**
```
openwrt/bin/ramips/openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin  (~4.3 MB)
openwrt/bin/ramips/openwrt-ramips-mt7620-uImage.bin
```

---

### uboot-mt7620
| | |
|---|---|
| **Fork** | https://github.com/aaronpowell/uboot-mt7620 |
| **Upstream** | https://github.com/tessel/uboot-mt7620 |
| **Branch** | `master` |
| **Local path** | `repos/uboot-mt7620` |

U-Boot bootloader for the MT7620 SoC.

**What changed:** Build flag tweak (`OPTFLAGS="-Os -fgnu89-inline"`) required for modern GCC — applied during build, not committed (build artifact only).

**Build output:**
```
uboot-mt7620/uboot.bin
uboot-mt7620/uboot.img
```

---

## Module repos

Forked and audited but stored separately (not submodules here — clone individually as needed).

| Module | Fork | Upstream | Changes |
|--------|------|----------|---------|
| `tessel` | [aaronpowell/tessel](https://github.com/aaronpowell/tessel) | [tessel/t1-runtime](https://github.com/tessel/t1-runtime) | Code fix: modernised tar bundling; removed live-network test dependency |
| `ambient-attx4` | [aaronpowell/ambient-attx4](https://github.com/aaronpowell/ambient-attx4) | [tessel/ambient-attx4](https://github.com/tessel/ambient-attx4) | Test/metadata modernisation |
| `climate-si7020` | [aaronpowell/climate-si7020](https://github.com/aaronpowell/climate-si7020) | [tessel/climate-si7020](https://github.com/tessel/climate-si7020) | Test/metadata modernisation |
| `relay-mono` | [aaronpowell/relay-mono](https://github.com/aaronpowell/relay-mono) | [tessel/relay-mono](https://github.com/tessel/relay-mono) | Test/metadata modernisation |
| `servo-pca9685` | [aaronpowell/servo-pca9685](https://github.com/aaronpowell/servo-pca9685) | [tessel/servo-pca9685](https://github.com/tessel/servo-pca9685) | Test/metadata modernisation |
| `accel-mma84` | [aaronpowell/accel-mma84](https://github.com/aaronpowell/accel-mma84) | [tessel/accel-mma84](https://github.com/tessel/accel-mma84) | Test/metadata modernisation |

---

## Upstream-only repos (not forked, reference only)

| Repo | Purpose |
|------|---------|
| [tessel/project](https://github.com/tessel/project) | Original Tessel project governance/roadmap |
| [tessel/t2-docs](https://github.com/tessel/t2-docs) | Official T2 documentation source |
| [tessel/t2-hardware](https://github.com/tessel/t2-hardware) | KiCad PCB design files |
| [tessel/t2-start](https://github.com/tessel/t2-start) | Getting started page |
| [tessel/t2-vm](https://github.com/tessel/t2-vm) | Virtual machine (deferred, may never be needed) |
