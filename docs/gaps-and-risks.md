# Gaps and Risks

Current status of known incomplete work, technical risks, and recommended next steps.

---

## Hardware validation (blocker for everything below)

**Status:** ⏳ Pending — no hardware attached during software revival work.

All software-side validation has passed (CLI tests, release dry-runs, artifact integrity). The remaining gap is:

- Physical board provisioning over Windows USB
- Firmware flash via `t2 update --firmware-path ... --openwrt-path ...`
- Confirming `t2 version` shows expected versions
- Running and verifying a hello-world script
- Verifying LED toggle, module port GPIO

**What to do:** Follow [`getting-started.md`](getting-started.md). Report any failures here as new issues.

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

---

## OpenWrt upstream uplift

**Status:** 📋 Planned — not started.

The current image is built from a heavily aged OpenWrt snapshot (Barrier Breaker era, ~2014 base). Feasibility assessment recommends targeting **OpenWrt 24.10.x** for the MT7620.

**Key finding:** Modern on-device Node.js is **not realistic** for the MT7620 (MIPS32 soft-float). The practical architecture is:
- Keep `spid` and `usbexecd` on-device (they're C daemons, not Node)
- Use Node.js 8.11.3 (the last version that built for MIPS32 soft-float) for user scripts
- Push more tooling host-side

**Risks:**
- MT7620 support in current OpenWrt upstream may need re-validation
- Tessel board-specific packages, patches, and configs need porting to the newer OpenWrt build system
- Node packaging strategy needs revisiting

**Why it matters:** The current image has known-old SSH (weak key exchange algorithms, requires `-oKexAlgorithms=+diffie-hellman-group1-sha1` workaround), old OpenSSL, and no security updates since 2018.

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
