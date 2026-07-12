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
| Board provisioning (Windows USB) | 🔄 In progress — USB attach to WSL has usbipd quirks |
| Firmware flashed to hardware | ⏳ Pending hardware validation |
| Hello-world app on device | ⏳ Pending hardware validation |
| Module library compatibility | ✅ In-scope libraries audited + test-modernised |
| OpenWrt upstream uplift (24.10.x) | 📋 Planned — not started |

## Related upstream organisations

- [github.com/tessel](https://github.com/tessel) — original Tessel GitHub org (unmaintained)
- [tessel.io](https://tessel.io) — project website (may be stale)
