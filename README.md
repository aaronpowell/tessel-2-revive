# Tessel 2 Revival

A personal-use revival of the [Tessel 2](https://tessel.io) development board ecosystem. The original project has been unmaintained since ~2018; this repo is the coordination hub for modernising it enough to be usable on Windows 11 / WSL2 with current Node.js tooling.

## Quick orientation for agents

This repository is optimised for agent-assisted iteration. Read these files in order:

1. [`docs/architecture.md`](docs/architecture.md) — hardware and software stack overview
2. [`docs/how-it-works.md`](docs/how-it-works.md) — deep-dive explainer: how OpenWrt, on-device Node.js, and code deploy actually work
3. [`docs/repos.md`](docs/repos.md) — every forked repo, what changed, and where it lives
4. [`docs/getting-started.md`](docs/getting-started.md) — how to flash a board and run an app today
5. [`docs/gaps-and-risks.md`](docs/gaps-and-risks.md) — known incomplete work and technical risk areas
6. [`docs/external-references.md`](docs/external-references.md) — upstream Tessel docs, datasheets, and community links

The forked repos are included as git submodules under [`repos/`](repos/).

### OpenWrt 25.12 uplift & production firmware

The board has been brought forward from its 2016 OpenWrt 15.05 (Chaos Calmer)
factory image all the way to **OpenWrt 25.12.5 / kernel 6.12.94**, with an
on-device **Node.js 8.11.3** runtime and the Tessel JS library — fully
hardware-validated (`t2 run` blinks the LEDs).

> **📦 Just want to flash a board?** Grab the latest prebuilt image from
> [**Releases**](https://github.com/aaronpowell/tessel-2-revive/releases/latest).
> Each release ships a `new_build_*.tar.gz` restore bundle (use this with `t2 restore`)
> and the raw `.bin` sysupgrade image. Flashing steps are in
> [`docs/production-image-and-release.md`](docs/production-image-and-release.md).
>
> Since `v25.12.5-node8-r2`, a freshly flashed board names itself
> `tessel-<release>-<mac4>` (e.g. `tessel-v25-12-5-node8-r2-fc2c`) instead of showing up
> as the stock `OpenWrt` — so you can tell boards apart in `t2 list`. Rename anytime with
> `t2 rename <name>`.

See:

- [`docs/production-image-and-release.md`](docs/production-image-and-release.md) —
  **start here for the production image**: what's in it, how to build/flash/validate, `/etc/tessel-release`, and how to cut a release
- [`docs/openwrt-incremental-upgrade.md`](docs/openwrt-incremental-upgrade.md) —
  the per-hop 15.05 → 25.12 root-cause roadmap (every break + fix, pinned to source)
- [`docs/openwrt-upgrade-progress.md`](docs/openwrt-upgrade-progress.md) —
  the narrative journey and lessons learned
- [`build/openwrt-incremental/`](build/openwrt-incremental/) — the containerised
  build system (Dockerfile, `build.sh`, the Tessel DTS/patches/overlay, and the node-8 payload scripts)

### Cloning on Windows

`repos/openwrt` and `repos/uboot-mt7620` are marked `update = none` — they are large, Linux-only build inputs and are skipped automatically by `git clone --recurse-submodules` on Windows. A standard clone gives you everything needed for CLI and firmware work:

```powershell
git clone --recurse-submodules https://github.com/aaronpowell/tessel-2-revive.git
```

To also initialise the Linux build repos (WSL/Linux only):
```bash
git submodule update --init repos/openwrt repos/uboot-mt7620
```

### Agent sessions and OpenWrt

Agent sessions that need to modify OpenWrt package files should be started from **WSL**, where the repo already lives at `/home/aaron/code/github/tessel/openwrt`. The `t2-build` Docker Compose setup clones openwrt internally and does not require it on the Windows filesystem.

## Milestone definition (first revival target)

On **Windows 11 / WSL2** with **current Node.js LTS**:

- Install the revived `t2-cli` from the fork
- Recover / provision a board over USB without depending on any Tessel-owned infrastructure
- Update OpenWrt + SAMD21 firmware from fork-owned release artifacts
- Reach the board over USB and SSH
- `t2 run` / `t2 push` JavaScript on real hardware

**In-scope module libraries for this milestone:**
`tessel`, `ambient-attx4`, `climate-si7020`, `relay-mono`, `servo-pca9685`, `accel-mma84`

**Explicit non-goals (deferred):**
macOS/Linux parity, full module ecosystem, major OpenWrt upstream uplift, camera/audio/RFID/BLE, OTA/fleet features.

## Repository layout

```
tessel-2-revive/
├── README.md                  ← you are here
├── docs/
│   ├── architecture.md        ← T2 hardware/software stack
│   ├── how-it-works.md        ← deep-dive: OpenWrt, Node.js, deploy flow
│   ├── repos.md               ← forked repo inventory
│   ├── getting-started.md     ← flash + hello world walkthrough
│   ├── gaps-and-risks.md      ← known gaps, risks, next steps
│   └── external-references.md ← upstream docs + datasheets
└── repos/                     ← git submodules (one per forked repo)
    ├── t2-cli/
    ├── t2-firmware/
    ├── t2-build/
    ├── t2-release/
    ├── openwrt-tessel/
    ├── openwrt/
    └── uboot-mt7620/
```

## Current status (July 2026)

| Area | Status |
|------|--------|
| Host CLI modernisation | ✅ Done — runs on Node 20+ / WSL2 / Windows |
| GitHub-native release plumbing | ✅ Done — `t2-release` reworked |
| SAMD21 firmware build | ✅ Builds locally |
| U-Boot build | ✅ Builds locally |
| OpenWrt legacy image build | ✅ Builds via Docker (Ubuntu 18.04 container) |
| Release artifacts assembled | ✅ Local tarballs + `builds.json` generated |
| Board provisioning (Windows USB) | ✅ Done — run `t2-cli` natively in Windows PowerShell (avoids usbipd/WSL quirks) |
| Firmware flashed to hardware | ✅ Done — flashed + validated via `t2 restore` |
| Hello-world app on device | ✅ Done — `t2 run` deploys and blinky drives LED0/LED1 |
| Module library compatibility | ✅ In-scope libraries audited + test-modernised |
| **OpenWrt upstream uplift** | ✅ **Complete — 25.12.5 / kernel 6.12.94 + Node 8.11.3, released as [`v25.12.5-node8-r2`](https://github.com/aaronpowell/tessel-2-revive/releases/latest)** |
| Default device hostname | ✅ Done — self-names `tessel-<release>-<mac4>` instead of `OpenWrt` |
| WiFi station mode on 25.12 | ⏳ Not yet exercised |
| `t2 update` (no explicit paths) | ⚠️ Needs the `t2-cli` `builds` release published — use `t2 restore` or explicit `--openwrt-path` |

## Related upstream organisations

- [github.com/tessel](https://github.com/tessel) — original Tessel GitHub org (unmaintained)
- [tessel.io](https://tessel.io) — project website (may be stale)
