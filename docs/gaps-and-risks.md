# Gaps and Risks

Current status of known incomplete work, technical risks, and recommended next steps.

---

## Hardware validation (latest session findings)

**Status:** ✅ Validated on real hardware (Windows USB path).

Validated outcomes from the latest recovery session:

- `t2 list --usb` can discover a connected board on Windows
- `t2 provision` completes successfully after USB process lifecycle hardening
- `t2 restore --usb` succeeds when `T2_RESTORE_URL` points to a valid factory tarball
- Post-restore reboot reached steady blue POWER LED and board recovered to usable state

Observed nuance:

- `t2 update` may still fail at firmware bootloader handoff (`No device found in bootloader mode`) even when OpenWrt transfer succeeds; this remains a known instability and should be treated separately from restore.

### OpenWrt 24.10 image — flashed, but device does not come back up

**Status:** ⛔ Core blocker for the uplift (see *OpenWrt upstream uplift* below).

In the latest session the freshly built **OpenWrt 24.10 (kernel 6.6.144)** sysupgrade image was
applied to real hardware with `t2 update --usb --openwrt-path <sysupgrade.bin>` (firmware
correctly skipped). The transfer + flash completed (`Finished updating Tessel with local
builds.`) and the board re-enumerated on USB — but **`t2-cli` can never connect** to the
updated image (`version --usb` sits at `Looking for your Tessel...` indefinitely), whereas the
factory image connects in seconds and `t2 restore` reconnects instantly.

**Root cause (diagnosed):** the on-device `spid`/`usbexecd` bridge that `t2-cli` talks to over
USB cannot start on kernel 6.6. `tessel-tools` builds, installs, and is enabled on boot
(`S60spid`/`S60usbexecd`), but `spid-start` runs `exec spid /dev/spidev32766.1 2 1 …` and the
2016-era `spid` drives GPIO via the legacy `/sys/class/gpio` sysfs interface. On 6.6 the spidev
node name/numbering is DTS-dependent (that node likely doesn't exist) and sysfs GPIO is
deprecated/removed — so the coprocessor bridge never comes up.

**Recovery:** every affected device was restored to the known-good factory image via the
local-tarball path (`python -m http.server 8765` + `T2_RESTORE_URL`), which is reliable. A
physical USB replug is sometimes needed to re-establish the data interface after heavy
restore/flash cycles.

---

## USB attachment on WSL2

**Status:** 🔄 Partially resolved.

`usbipd attach` was failing with a spurious `VBoxUsbMon` error. This was a bug in older `usbipd-win` versions.

**Resolution:** Upgrade `usbipd-win` to v4+: `winget upgrade usbipd`.

**Remaining risk:** If USB attachment still fails after upgrade, the workaround is to run `t2-cli` natively in Windows PowerShell (not WSL), since Windows already sees the device. The built `.bin` artifacts are accessible via `\\wsl.localhost\Ubuntu\...` UNC paths.

---

## Release artifacts not published to GitHub

**Status:** 📋 Ready to publish, not yet done.

The release plumbing is in place:
- `t2-release` can assemble and publish artifacts
- `t2-cli/resources/releases/builds.json` has a manifest entry pointing at `aaronpowell/t2-cli` GitHub Releases
- Local tarballs are assembled at `t2-release/.release-work/...`

**What's missing:** The `t2-cli` GitHub Release tagged `builds` has not been created and populated yet, so `t2 update` (without explicit `--firmware-path` / `--openwrt-path`) will fail with a 404.

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

**Status:** 🔬 Attempted — build & flash succeed; **on-device bring-up blocked** by the `spid` bridge.

The current image is built from **OpenWrt Chaos Calmer 15.05-rc2** (2015, kernel 3.18), per the
package feed pinned in `openwrt-tessel/config.mk:77`. This session targeted, built, and flashed
**OpenWrt 24.10.x (kernel 6.6.144)** for the MT7620.

**What now works end-to-end:**
- The 24.10 tree builds a valid Tessel sysupgrade artifact
  (`bin/targets/ramips/mt7620/openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin`), after
  fixing several staging/toolchain build blockers (target sysroot visibility in `rules.mk`,
  `opkg`, and a `urngd` CMake CRT-probe workaround).
- `t2 update --openwrt-path` transfers, flashes, and reboots the device cleanly.
- The board boots the new image and re-enumerates on USB.

**What blocks it (the hard part):** `t2-cli` cannot reach the updated image because the
`spid`/`usbexecd` coprocessor bridge does not start on kernel 6.6 — see *Hardware validation →
OpenWrt 24.10 image* above. Fixing this requires porting the Tessel bridge to modern kernel
interfaces:
- add a **DTS spidev binding** so the SPI node exists (replacing the hard-coded
  `/dev/spidev32766.1`), and
- port `spid`'s GPIO handling from legacy `/sys/class/gpio` to **libgpiod / the gpio
  character device** (or re-enable `CONFIG_GPIO_SYSFS` and fix numbering as a stopgap).

This is best debugged with an **MT7620 UART serial console**, which we do not yet have wired up.

**Key finding (unchanged):** modern on-device Node.js is **not realistic** for the MT7620
(MIPS32 soft-float). The uplift does **not** change this — Node stays at **8.11.3** regardless
of OpenWrt version. The practical architecture is:
- Keep `spid` and `usbexecd` on-device (C daemons, not Node) — but re-ported to modern SPI/GPIO
- Use Node.js 8.11.3 for user scripts
- Push more tooling host-side

**Remaining risks:**
- The `spid`/DTS re-port is genuine driver/bring-up engineering, not a config change
- Firmware bootloader handoff during `t2 update` is still unreliable and must stay
  human-supervised (see Hardware validation)
- Tessel board-specific packages/patches/configs continue to need porting as upstream moves

**Why it matters / risk of staying:** the current image has known-old SSH (weak KEX; requires
`-oKexAlgorithms=+diffie-hellman-group1-sha1`), an EOL OpenSSL/TLS stack, a 2015 WiFi stack, and
no security updates for ~10 years. A full risk breakdown for **not** upgrading (calibrated for an
isolated, non-public, competently-managed network) plus the capability gaps is in
[`security-threat-assessment.md`](./security-threat-assessment.md).

---

## SSH compatibility

**Status:** ⚠️ Known issue on the current firmware.

Modern OpenSSH clients reject the device's offered key exchange algorithms by default. The workaround:

```bash
ssh -oKexAlgorithms=+diffie-hellman-group1-sha1 root@<tessel>.local -i ~/.tessel/id_rsa
```

`t2-cli` may also need this flag injected into its SSH connection options. **Needs verification on real hardware.**

The long-term fix is the OpenWrt uplift (above), which would bring a current OpenSSH build.

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
