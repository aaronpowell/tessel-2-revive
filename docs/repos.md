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
- Upgraded `usb` dependency to `^2.16.0` to support modern Node.js (20+ / 22)
- Added USB daemon/process close fallback handling to prevent provision hangs when remote close events are missing
- Made crash reporter non-blocking when unconfigured (prevents noise in tests)
- Removed obsolete `npm rebuild --update-binary` flag from postinstall
- Updated postinstall script so it no longer requires `t2` to be globally linked before `npm install` completes
- Seeded `releases/builds.json` **in this repo** with the update-feed manifest (see
  [`gaps-and-risks.md`](./gaps-and-risks.md)). The feed moved off `t2-cli` deliberately: artifacts
  belong with the hardware-validated releases, not with the CLI.
- Added `.github/workflows/validate-release-manifest.yml` to keep manifest consistent
- Updated README with WSL2 setup instructions and GitHub artifact layout documentation
- Updated stale issue/repo URLs

**Artifact configuration (environment variables).** Defaults live in `t2-cli/lib/remote.js`; every
one is overridable so a fork or a local file server can be dropped in without code changes.
```
T2_ARTIFACT_REPOSITORY — owner/repo holding the releases  (default: aaronpowell/tessel-2-revive)
T2_BUILDS_JSON_URL     — update feed  (default: raw.githubusercontent.com/<repo>/main/releases/builds.json)
T2_RELEASES_BASE_URL   — release asset base URL  (default: github.com/<repo>/releases/download)
T2_RESTORE_URL         — restore/factory tarball  (default: <repo>/releases/latest/download/tessel-restore.tar.gz)
T2_PACKAGES_BASE_URL   — binaries  ·  T2_SDK_BASE_URL — SDK  ·  T2_RUSTCC_URL — Rust cross-compiler
```

Known archived fallback for the original Tessel restore image:
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

Build tooling for producing Tessel release images. Works on **Windows, Linux, and macOS** via Docker.

**What changed:**
- Added `docker-compose.yml` — self-contained Windows-friendly build. Source lives in a Docker named Linux volume (avoids NTFS colon/case-sensitivity issues entirely). Artifacts exported to `./output/`.
- Added `docker/openwrt-bionic/build-entrypoint.sh` — handles clone-on-first-run, host-tools build, world build, and artifact export.
- Updated `docker/openwrt-bionic/Dockerfile` to use the entrypoint script.
- Rewrote README with Windows-first quick start.

**To build an OpenWrt image (Windows, Linux, or macOS):**
```powershell
# clone t2-build on its own (no need to clone openwrt separately)
git clone https://github.com/aaronpowell/t2-build.git
cd t2-build
docker compose run --rm build
# artifacts appear in ./output/
```

The container clones `openwrt` and `openwrt-tessel` internally on first run — you never need to clone `openwrt` directly on Windows.

Also available: `openwrt-env.sh` for direct Linux/WSL builds mounting a sibling workspace.

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
- Generates the `builds.json` manifest pointing at `aaronpowell/tessel-2-revive` GitHub Releases
- Added local dry-run / assembly flow (no GitHub credentials required for testing)
- Added test suite (`tests/release.test.js`)
- Updated README

**GitHub asset layout expected by t2-cli:**
```
aaronpowell/tessel-2-revive GitHub Releases:
  Tag: v<openwrt>-node<n>-r<N>          e.g. v25.12.5-node8-r4
    → tessel-restore.tar.gz             (restore/factory bundle — name is load-bearing,
                                         t2 restore reads releases/latest/download/<this>)
    → tessel-update.tar.gz              (sysupgrade bundle for t2 update)
    → tessel-<ver>-PROD-node<n>-r<N>.bin (raw image for --openwrt-path)

aaronpowell/tessel-2-revive repository:
  Branch: main
    → releases/builds.json              (update feed, fetched by the update command)
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

Custom OpenWrt fork for the MT7620 target, and the base the whole uplift started from.
This is a heavily aged snapshot: **OpenWrt Chaos Calmer 15.05.1**, forked from
`tessel/openwrt` at [`c61b3d8`](https://github.com/tessel/openwrt/commit/c61b3d89a56bbf4209dea75432f506e9dc66d55b)
(2018-07-17), with Tessel-specific patches on top.

Verify rather than trust that: in `include/version.mk` at the pinned commit, the version
defaults are `15.05.1` and `Chaos Calmer`, and the fork is 2 commits ahead of / 0 behind
that base. 15.05 dates from September 2015, so the tree was already around three years
stale when it was snapshotted, and a decade stale by the time of the uplift.

Read the defaults, not a literal line — `version.mk` has no line saying
`VERSION_CODE := Chaos Calmer`. Each variable is assigned from its `CONFIG_*` symbol and
then defaulted on the next line if that came back empty:

```make
VERSION_NUMBER:=$(call qstrip_escape,$(CONFIG_VERSION_NUMBER))
VERSION_NUMBER:=$(if $(VERSION_NUMBER),$(VERSION_NUMBER),15.05.1)

VERSION_CODE:=$(call qstrip_escape,$(CONFIG_VERSION_NUMBER))
VERSION_CODE:=$(if $(VERSION_CODE),$(VERSION_CODE),Chaos Calmer)
```

Neither `CONFIG_VERSION_NUMBER` nor `CONFIG_VERSION_NICK` is set by `openwrt-tessel`'s
`config.mk`, so both defaults are what actually apply. (Note the upstream bug in the
second pair: `VERSION_CODE` reads `CONFIG_VERSION_NUMBER`, not `CONFIG_VERSION_NICK`.
It does not affect the conclusion here, since neither symbol is set.)

**Open question — 15.05.1 vs 15.05-rc2.** The pinned tree defaults to `15.05.1`, but the
same `config.mk` points the package feed at a release candidate:

```make
CONFIG_VERSION_REPO="http://downloads.openwrt.org/chaos_calmer/15.05-rc2/%S/packages"
```

and 15.05-rc2 is also what the shipped factory boards report. Nobody has established the
factory build's provenance, and it is not worth chasing — the uplift replaced the whole
tree regardless. Recorded so the discrepancy is not mistaken for an error in either
number.

**What changed:**
- Fixed dead/legacy `git://` source fetch URLs for: `hostapd`, `usign`, `odhcpd`, `libubox`, `firewall`, `netifd`, `iwinfo`, `procd`, `ubox`, `ubus`, `uci`, `jsonfilter`
- Fixed `libpcap` packaging/install failure
- `tools/m4`: added patches for modern glibc compatibility
- `tools/make-ext4fs`: added patch for modern kernel headers
- **Removed 348 `wwan` and `usbmode` VID:PID data files** — these used colon characters in filenames (e.g. `0421:03a7`) which prevented cloning on Windows. They were USB modem device descriptors unused by any Tessel build.

> **Note:** You do not need to clone this repo directly on Windows. The `t2-build` Docker Compose setup clones it internally inside a Linux container volume.

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
| `tessel` (npm name of `t1-cli`) | [aaronpowell/t1-cli](https://github.com/aaronpowell/t1-cli) | [tessel/t1-cli](https://github.com/tessel/t1-cli) | Code fix: modernised tar bundling; removed live-network test dependency |
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
