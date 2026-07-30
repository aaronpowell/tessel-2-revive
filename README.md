# Tessel 2 Revival

Bringing the [Tessel 2](https://en.wikipedia.org/wiki/Tessel_%28company%29) development
board back to life on a modern toolchain.

Tessel 2 was a 2015-era JavaScript-on-hardware board: a MediaTek MT7620N running
OpenWrt Linux with a real Node.js runtime, paired with an Atmel SAMD21 coprocessor for
GPIO/SPI/I²C/UART/ADC. The company wound down and the project has been unmaintained
since roughly 2018. The boards still work — but the OS on them was OpenWrt 15.05
(kernel 3.18, 2015), the on-device Node was 4.2.1, the host CLI would not run on a
current Node, and the update/release infrastructure it depended on no longer exists.

This repository is the record of fixing all of that, and the place the resulting
firmware images are published from.

## What state is it in?

**Working.** The board now runs **OpenWrt 25.12.5 / kernel 6.12.94** with an on-device
**Node.js 8.11.3** runtime, and the original developer workflow — `t2 run`, `t2 push`,
`t2 update`, WiFi, LAN discovery — works again. Every step of this was validated on
real hardware, not just built.

| | |
|---|---|
| Device OS | OpenWrt 25.12.5, kernel 6.12.94 (from 15.05 / 3.18) |
| On-device Node | 8.11.3, soft-float MIPS (from 4.2.1) |
| Host CLI | `t2-cli` runs on current Node.js (20+) |
| Deploy | `t2 run` / `t2 push` deploy and execute JS on hardware |
| WiFi | Station mode works; board joins a network unattended after flashing |
| Discovery | mDNS/LAN discovery and SSH work from Windows |
| Updates | `t2 update` pulls from this repo's release feed and preserves your config |
| Latest release | [`v25.12.5-node8-r5`](https://github.com/aaronpowell/tessel-2-revive/releases/latest) |

Known gaps and rough edges are tracked honestly in
[`docs/gaps-and-risks.md`](docs/gaps-and-risks.md).

## Just want to flash a board?

Grab the latest image from
[**Releases**](https://github.com/aaronpowell/tessel-2-revive/releases/latest). Each
release since `r4` ships three assets:

| Asset | Use |
|---|---|
| `tessel-restore.tar.gz` | Full restore over USB (`t2 restore`) — use this on a board that is on old firmware or is not booting |
| `tessel-update.tar.gz` | In-place update of a board already on a 25.12 image (`t2 update`) — preserves your WiFi config and hostname |
| `tessel-25.12-PROD-node8-r5.bin` | The raw sysupgrade image, if you want to flash it yourself |

> **Note:** the older `r1` and `r2` releases ship a differently-named
> `new_build_*.tar.gz` restore bundle and are not in the `t2 update` feed. Start from
> the latest release.

Flashing steps, validation gates, and how to build the image yourself are in
[`docs/production-image-and-release.md`](docs/production-image-and-release.md). A
first-board walkthrough is in [`docs/getting-started.md`](docs/getting-started.md).

A freshly flashed board names itself `tessel-<release>-<mac4>` (e.g.
`tessel-v25-12-5-node8-r5-fc2c`) rather than showing up as the stock `OpenWrt`, so you
can tell boards apart in `t2 list`. Rename it any time with `t2 rename <name>`.

## Documentation

**Understanding the hardware and the stack**

- [`docs/architecture.md`](docs/architecture.md) — the two-processor design, the SPI
  bridge, and how a `led[0].toggle()` becomes a pin change
- [`docs/how-it-works.md`](docs/how-it-works.md) — the explainer: is OpenWrt a real
  Linux distro, is that a real Node.js binary, which npm packages can you actually push
- [`docs/external-references.md`](docs/external-references.md) — upstream Tessel docs,
  datasheets, community links

**Using it**

- [`docs/getting-started.md`](docs/getting-started.md) — fresh board to running app
- [`docs/production-image-and-release.md`](docs/production-image-and-release.md) —
  what is in the production image, how to build/flash/validate it, and how to cut a
  release
- [`tools/`](tools/) — small scripts for running a shell command on a board over USB
  or SSH, which `t2-cli` itself cannot do

**How the uplift was done** (the interesting part, if you're here from a blog post)

- [`docs/openwrt-incremental-upgrade.md`](docs/openwrt-incremental-upgrade.md) — the
  per-hop 15.05 → 25.12 roadmap: every single thing that broke, the root cause, and
  the fix, pinned to upstream source
- [`docs/openwrt-upgrade-progress.md`](docs/openwrt-upgrade-progress.md) — the
  narrative version, including the dead ends
- [`docs/repos.md`](docs/repos.md) — every forked repo and what changed in it
- [`docs/gaps-and-risks.md`](docs/gaps-and-risks.md) — what is still incomplete
- [`docs/security-threat-assessment.md`](docs/security-threat-assessment.md) and
  [`docs/risk-assessment-openwrt-18.06.md`](docs/risk-assessment-openwrt-18.06.md) —
  assessments written along the way

The short version of the uplift: a single 15.05 → 25.12 jump fails in ways that are
impossible to diagnose, because a decade of breakages land at once. Doing it as an
**incremental hop ladder** — 15.05 → 17.01 → 18.06 → 19.07 → 21.02 → 22.03 → 23.05 →
24.10 → 25.12, flashing and gating real hardware at every rung — turned one
intractable problem into eight small, individually-diagnosable ones.

## Repository layout

```
tessel-2-revive/
├── docs/                      # see above
├── build/openwrt-incremental/ # the containerised OpenWrt build system:
│                              #   Dockerfile, build.sh, board DTS,
│                              #   kernel patches, overlay, node-8 payload scripts
├── tools/                     # usb-exec.js / lan-exec.js hardware probes
├── tessel-scripts/            # sample scripts to run on a board
├── releases/builds.json       # the `t2 update` feed
└── repos/                     # git submodules: the forked upstream repos
```

The forks under `repos/` are where the actual code changes live —
[`docs/repos.md`](docs/repos.md) explains what each one is and what was changed:

| Submodule | Role |
|---|---|
| `t2-cli` | The `t2` host CLI — modernised, plus WiFi/mDNS/SSH/update fixes |
| `t2-firmware` | SAMD21 firmware and the on-device Tessel JS runtime |
| `openwrt-tessel` | OpenWrt packages (including the Node.js package) |
| `t2-build` | Containerised build tooling |
| `t2-release` | Release artifact assembly |
| `openwrt`, `uboot-mt7620` | Large Linux-only build inputs |

## Working with this repo

```bash
git clone --recurse-submodules https://github.com/aaronpowell/tessel-2-revive.git
```

`repos/openwrt` and `repos/uboot-mt7620` are marked `update = none` in
[`.gitmodules`](.gitmodules) — they are large, Linux-only build inputs and are skipped
by default. A standard clone gives you everything needed for CLI, firmware, and image
work. To pull them too (Linux or WSL only):

```bash
git submodule update --init repos/openwrt repos/uboot-mt7620
```

Building the OpenWrt image does **not** require them; the build under
[`build/openwrt-incremental/`](build/openwrt-incremental/) fetches its own sources
inside a container.

### Host platform

Development and validation were done on **Windows 11** with Node.js 20+, running
`t2-cli` natively in PowerShell (which avoids USB passthrough quirks) and using Docker
for the OpenWrt builds. Nothing here is deliberately Windows-only — the CLI is plain
Node.js and the image build is containerised — but macOS and Linux are untested, so
expect to hit small things. Reports welcome.

## Related

- [github.com/tessel](https://github.com/tessel) — the original Tessel GitHub org
  (unmaintained)
- [tessel.io](https://tessel.io) — the original project website (stale)
- Upstream T2 documentation is archived at
  [tessel.gitbooks.io/t2-docs](https://tessel.gitbooks.io/t2-docs/content/)
