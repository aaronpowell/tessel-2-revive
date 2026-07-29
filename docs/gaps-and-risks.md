# Gaps and Risks

Current status of known incomplete work, technical risks, and recommended next steps.

---

## Hardware validation (current status)

**Status:** ✅ Fully validated on real hardware (Windows USB path). Device is on
**OpenWrt 25.12.5 / kernel 6.12.94** with on-device **Node.js 8.11.3**, shipped as
release [`v25.12.5-node8-r2`](https://github.com/aaronpowell/tessel-2-revive/releases/tag/v25.12.5-node8-r2).

> **The uplift is complete.** The 15.05 → 25.12 climb was done as a **cautious incremental
> hop** (15.05 → 17.01 → 18.06 → 19.07 → 21.02 → 22.03 → 23.05 → 24.10 → 25.12) rather than
> one giant jump, and every hop was hardware-gated. That method is what made each break a
> small, individually-diagnosable delta. See
> [`production-image-and-release.md`](./production-image-and-release.md) for the current
> image, [`openwrt-incremental-upgrade.md`](./openwrt-incremental-upgrade.md) for the
> per-hop root-cause roadmap, and [`openwrt-upgrade-progress.md`](./openwrt-upgrade-progress.md)
> for the narrative journey.
>
> A **USB serial-console root shell** (works on any image, no `spid`/WiFi/soldering) was
> discovered early and made every subsequent hop diagnosable — it is the single most useful
> tool in this repo for firmware debugging.

Validated outcomes:

- `t2 list --usb` can discover a connected board on Windows
- `t2 provision` completes successfully after USB process lifecycle hardening
- `t2 restore --usb` succeeds when `T2_RESTORE_URL` points to a valid tarball
- A **repackaged restore tarball** (target `-squashfs-sysupgrade.bin` swapped in as the
  SquashFS member) flashes a bootable image over the spid-free SAM3/DFU path — this is the
  primary flashing mechanism for the production image
- On 25.12.5: squashfs mounts, `spid` + `usbexecd` start at boot, `/dev/spidev1.0` exists,
  `node -e process.version` → `v8.11.3` with no SIGILL, and `t2 run` blinks LED0/LED1

Observed nuance:

- `t2 update` may still fail at firmware bootloader handoff (`No device found in bootloader mode`) even when OpenWrt transfer succeeds; this remains a known instability and should be treated separately from restore.
- `t2 restore` is **destructive to device identity**: it bulk-erases the flash and writes a
  freshly randomised MediaTek factory partition (MAC `02:a3:<4 random bytes>`, see
  `t2-cli/lib/tessel/restore.js`). The board's WiFi MAC — and therefore the default
  `tessel-<release>-<mac4>` hostname — changes after every restore. Don't treat either as a
  permanent serial number.

### OpenWrt 24.10 image — flashed, but device did not come back up

**Status:** ✅ **RESOLVED.** This was the core blocker for the uplift; it is fixed and the
ladder ran through to 25.12.

The freshly built **OpenWrt 24.10 (kernel 6.6)** sysupgrade image flashed successfully but
the board never came back — `t2-cli` could never connect, and reading the flash back showed
**all `0xFF`** (i.e. nothing had actually been written).

**Root cause (diagnosed):** an upstream `spi-rt2880.c` refactor dropped the driver's
`hw_reset_count` guard. The MT7620's two SPI controllers **share one reset line**, so probing
the second controller pulsed the reset a second time and knocked out the already-initialised
flash controller.

**Fix:** patch `822-SPI-rt2880-reset-shared-spi-block-once.patch` re-adds the atomic guard so
the shared SPI block is reset exactly once.

A second, independent 6.x break affected the `spid`/`usbexecd` coprocessor bridge: the 2016-era
`spid` drives GPIO via legacy sysfs and hardcoded global GPIO 2/1, but from kernel 6.6 the
`gpio-ralink` driver uses `bgpio_init()` and the SoC gpiochip base moved off 0 (observed 512).
**Fix:** `spid-start` now resolves bank 0's base at runtime; plus patch `999` for the CS1
pinmux and a `rohm,dh2228fv` spidev whitelist entry (kernels ≥5.15 reject the bare `spidev`
binding). All are carried in the production image.

**Recovery (still the reliable path if a board is ever bricked):** restore via the
local-tarball route (`python -m http.server 8765` + `T2_RESTORE_URL`). A physical USB replug
is sometimes needed to re-establish the data interface after heavy restore/flash cycles.

---

## USB attachment on WSL2

**Status:** 🔄 Partially resolved.

`usbipd attach` was failing with a spurious `VBoxUsbMon` error. This was a bug in older `usbipd-win` versions.

**Resolution:** Upgrade `usbipd-win` to v4+: `winget upgrade usbipd`.

**Remaining risk:** If USB attachment still fails after upgrade, the workaround is to run `t2-cli` natively in Windows PowerShell (not WSL), since Windows already sees the device. The built `.bin` artifacts are accessible via `\\wsl.localhost\Ubuntu\...` UNC paths.

---

## Release artifacts not published to GitHub

**Status:** 🔄 Partially resolved — **production firmware images are published**; the `t2-cli`
`builds` release for `t2 update` is still missing.

**What is published:** the production OpenWrt + Node images are attached to GitHub Releases on
this repo — see
[`v25.12.5-node8-r2`](https://github.com/aaronpowell/tessel-2-revive/releases/tag/v25.12.5-node8-r2)
(the `.bin` sysupgrade image plus a `new_build_*.tar.gz` restore bundle for `t2 restore`). That
covers the normal flashing path documented in
[`production-image-and-release.md`](./production-image-and-release.md).

The `t2-release` plumbing is also in place:
- `t2-release` can assemble and publish artifacts
- `t2-cli/resources/releases/builds.json` has a manifest entry pointing at `aaronpowell/t2-cli` GitHub Releases
- Local tarballs are assembled at `t2-release/.release-work/...`

**What's still missing:** The `t2-cli` GitHub Release tagged `builds` has not been created and populated yet, so `t2 update` (without explicit `--firmware-path` / `--openwrt-path`) will fail with a 404.

**How to fix:**
```bash
cd repos/t2-release
node lib/release.js --publish  # requires GH_TOKEN with write:packages
```

Until then, always use the explicit path flags:
```powershell
node .\bin\tessel-2.js update `
  --firmware-path <path>\firmware.bin `
  --openwrt-path  <path>\sysupgrade.bin
```

For `t2 restore`, if the default `new_build_next.tar.gz` URL is unavailable, use the archived source:
`https://web.archive.org/web/20201102173433/https://s3.amazonaws.com/builds.tessel.io/custom/new_build_next.tar.gz`

---

## OpenWrt upstream uplift

**Status:** ✅ **COMPLETE.** Built, flashed, and hardware-validated end-to-end at
**OpenWrt 25.12.5 / kernel 6.12.94**, released as `v25.12.5-node8-r2`.

The device previously ran **OpenWrt Chaos Calmer 15.05-rc2** (2015, kernel 3.18). It now runs
25.12.5 with the Tessel JS runtime working: `t2 run` / `t2 push` deploy and execute scripts and
blinky drives the on-board LEDs.

**How it was done:** as an **incremental hop ladder** (15.05 → 17.01 → 18.06 → 19.07 → 21.02 →
22.03 → 23.05 → 24.10 → 25.12), hardware-gating each hop. Every blocker turned out to be a
small, individually-diagnosable delta that a single 15.05→24.10 jump had hidden. Full per-hop
detail in [`openwrt-incremental-upgrade.md`](./openwrt-incremental-upgrade.md).

**The fixes that made it work** (all carried in the production image):

| Fix | What it solved |
|---|---|
| `822` shared-SPI reset guard | MT7620's two SPI controllers share a reset line; the refactored driver double-pulsed it → flash read all-`0xFF` → non-boot |
| `spid-start` runtime base resolver | kernel ≥6.6 `gpio-ralink` uses `bgpio_init()`, moving the gpiochip base off 0 (observed 512) |
| `999` CS1 pinmux | so the coprocessor enumerates as `/dev/spidev1.0` |
| `rohm,dh2228fv` spidev whitelist | kernels ≥5.15 reject the bare `spidev` binding |
| `CONFIG_MTD_SPLIT_FIRMWARE=y` | split the firmware partition into kernel + rootfs |
| `CONFIG_MIPS_FP_SUPPORT=y` | **the decisive one** — OpenWrt strips the kernel FP emulator, but V8's JIT emits `cop1` at runtime, so JS SIGILL'd on the FPU-less 24KEc |
| `/sys/class/leds/tessel:` LED path | `gpio-leds` device renamed on 6.x, so LED writes silently no-op'd |
| INITRAMFS forced off | `make defconfig` defaults it **on** for this target, yielding a RAM-root image instead of a flashable squashfs |

**Corrections to earlier assumptions in this document:**

- **libgpiod was never needed.** Legacy `CONFIG_GPIO_SYSFS` is an upstream default in the
  generic 6.12 config and works fine; only the gpiochip *base* had moved. The predicted
  "port `spid` to libgpiod / the gpio character device" work did not have to happen.
- **A soldered MT7620 UART console was never needed.** The **USB serial console** works on any
  image and was sufficient to debug every hop.
- **Node.js on-device is real, and stays at 8.11.3.** This constraint is unchanged and
  deliberate — see *Node.js version on device* below. It is built in an in-ladder OpenWrt
  19.07 toolchain (gcc-7.5 + musl, soft-float) and lifted onto 25.12, isolated under
  `/opt/tessel` with its library closure on `LD_LIBRARY_PATH`.

**Risks retired by the uplift:** the 2015 image's known-old SSH (weak KEX), EOL OpenSSL/TLS
stack, 2015 WiFi stack, and ~10 years of missing security updates. The original analysis of the
risk of *not* upgrading is preserved in
[`security-threat-assessment.md`](./security-threat-assessment.md) for context.

**Remaining risks:**

- Firmware bootloader handoff during `t2 update` is still unreliable and must stay
  human-supervised (see Hardware validation); `t2 restore` is the dependable path.
- Tessel board-specific packages/patches/configs will continue to need porting as upstream
  moves — the incremental ladder and the containerised build system make this tractable.
- WiFi station mode on 25.12 is exercised end-to-end (join, DHCP, LAN discovery, `t2 run`
  over WiFi, `t2 rename`) as of the r3 image — see *WiFi station mode and LAN discovery* below.

---

## SSH compatibility

**Status:** ⚠️ Known issue **on the 15.05 factory firmware**; ✅ **resolved at 18.06+**.

On the **factory (15.05)** image, modern OpenSSH clients reject the device's offered key exchange
algorithms by default. The workaround:

```bash
ssh -oKexAlgorithms=+diffie-hellman-group1-sha1 root@<tessel>.local -i ~/.tessel/id_rsa
```

**At 18.06.9 this is no longer needed:** the image ships **dropbear 2017.75**, which offers
modern KEX (curve25519-sha256), so current SSH clients and `t2-cli`'s SSH path connect without the
legacy-KEX override. This is one of the concrete risk items retired by the incremental uplift (see
[`risk-assessment-openwrt-18.06.md`](./risk-assessment-openwrt-18.06.md), T4).

**The mirror image of this bit us in `t2-cli` itself.** The CLI bundled `ssh2` 0.6.1, whose
key exchange list stops in 2014; 25.12's dropbear offers only `sntrup761x25519-sha512`,
`curve25519-sha256` and `diffie-hellman-group14-sha256`. The two sets do not intersect, so every
LAN connection failed the handshake — and because the connection code discarded the error, the CLI
reported the board as *unprovisioned* rather than saying the handshake failed. `ssh2` is now on
1.x and the error is logged. Worth remembering: "the device's SSH is too old" and "our SSH client
is too old" produce the same symptom from the outside.

---

## WiFi station mode and LAN discovery

**Status:** ✅ Validated on hardware (r3 image + current `t2-cli`).

Getting `t2 list` / `t2 run` to work over WiFi needed fixes on both sides. On the **image** side:
the stock OpenWrt `wifi-iface[0]` is an *AP*, so `t2 wifi` would have made the board broadcast
your network's name instead of joining it; `rpcd-mod-iwinfo` and a mDNS responder were absent
entirely; and OpenWrt ≥ 21.02 names the interface after the phy (`phy0-sta0`) while `t2-cli`
hardcodes `wlan0`. See [`production-image-and-release.md`](./production-image-and-release.md).

On the **CLI** side, three host-side faults each masked the next:

- Discovery listened for multicast on UDP 5353, a port shared with Bonjour, avahi and browsers;
  on Windows only one binder receives each datagram, so discovery succeeded roughly one run in
  three. `t2-cli/lib/mdns.js` now queries with the RFC 6762 §5.4 **QU (unicast response) bit**
  from an ephemeral port on every interface, so answers come straight back to us — 5/5 runs.
- `t2-cli` bundled an `ssh2` too old to negotiate with modern dropbear (above).
- `t2 run` deployed successfully and then printed nothing: it piped `process.stdin` into the SSH
  channel, and a non-TTY stdin ends immediately, which closed the pty's write side and made
  dropbear SIGHUP the script before it produced any output.

**Known limitation:** the rt2800 radio is 2.4 GHz only, so a 5 GHz-only network is invisible to it.

**Open image defect — `wireless.radio0.channel` is pinned to `1`.** OpenWrt's `wifi detect` writes
a fixed channel, which is right for an AP and wrong for a station: the radio parks on channel 1 and
never sees APs on 6 or 11. `wpa_supplicant` logs no association attempt at all and `iwinfo` reports
`Channel: 0`, which looks like a driver fault rather than a config one. `uci set
wireless.radio0.channel=auto` fixes it immediately and survives a reboot, so an already-configured
board is fine — but a freshly flashed one can only join a channel-1 network. This needs to move
into `98-tessel-wifi` next to `mode='sta'` for the next respin.

**Validated end-to-end on a clean r3 flash** (`4f3ad0c`), not just a live-patched board: every
`uci-defaults` script applied on first boot, the board joined the network, DHCP issued a lease with
the `Tessel 2` vendor class on the *first* request, `t2 list --lan` and `t2 provision` found and
authorized it, `t2 run index.js --lan` streamed `BLINK 1..24` with the LEDs physically confirmed,
and association, address and hostname all survived a power cycle.

Note that after `t2 restore` the USB data interface does not always re-enumerate across a power
cycle; LAN/SSH still works, so a USB timeout here is not a boot failure.

---

## Node.js version on device

**Status:** ℹ️ Accepted constraint.

The device currently runs Node.js **8.11.3** (the last Node version that was successfully cross-compiled for MIPS32 soft-float / OpenWrt). This is EOL.

**Impact on module compatibility:**
- Most Tessel module libraries were written for Node 6–8 and work fine
- Modern npm packages that use ES2018+ syntax or Node 12+ APIs will not run on-device
- User scripts must stay within the Node 8 subset; host-side tooling can use any Node version

**Workaround for now:** No action needed — just be aware when `require()`-ing npm packages in device scripts.

---

## Module libraries — hardware untested

**Status:** ⏳ Pending hardware validation.

The in-scope module libraries were audited and test/metadata-modernised on the host side. None have been tested with real hardware since the revival:

| Module | Host tests | Hardware tested |
|--------|-----------|----------------|
| `tessel` | ✅ | ⏳ |
| `ambient-attx4` | ✅ | ⏳ |
| `climate-si7020` | ✅ | ⏳ |
| `relay-mono` | ✅ | ⏳ |
| `servo-pca9685` | ✅ | ⏳ |
| `accel-mma84` | ✅ | ⏳ |

---

## openwrt-tessel submodule linkage

**Status:** ⚠️ Minor issue.

The `openwrt-tessel` repo includes `openwrt` as a submodule pointing at `tessel/openwrt`. After forking, this pointer still references the upstream rather than `aaronpowell/openwrt`. This means builds via `openwrt-tessel` will pull upstream sources, not the fork's patched version.

**How to fix:**
```bash
cd repos/openwrt-tessel
git submodule set-url openwrt https://github.com/aaronpowell/openwrt.git
git add .gitmodules
git commit -m "Point openwrt submodule at fork"
git push
```

For now, build directly from `repos/t2-build` (which uses `repos/openwrt` directly) rather than through `openwrt-tessel`.

---

## Rust SDK

**Status:** 🔕 Deferred — not in scope for first milestone.

`t2-cli` previously supported deploying Rust code via `rustcc.tessel.io` (dead). The Rust cross-compilation toolchain and SDK distribution are not addressed in this revival. References to the Rust SDK remain in `lib/install/rust.js` and `lib/tessel/deployment/rust.js` but those code paths will fail gracefully.

---

## Windows native USB driver (longer term)

**Status:** ℹ️ Informational.

The Tessel SAMD21 USB interface (`1209:7551`) uses a custom USB device class. On Windows, `t2-cli` uses the `usb` npm package (libusb). For best results:
- Use [Zadig](https://zadig.akeo.ie/) to install the WinUSB or libusbK driver for the Tessel if the `usb` module can't open the device
- This is a one-time setup per machine
