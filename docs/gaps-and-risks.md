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

## Release artifacts and the `t2 update` feed

**Status:** 🔄 Artifacts published and the feed is written and validated; **blocked on this repo
being private.**

**What is published.** Production images are attached to GitHub Releases on this repo. The current
recommended image is
[`v25.12.5-node8-r4`](https://github.com/aaronpowell/tessel-2-revive/releases/tag/v25.12.5-node8-r4)
(r1 and r2 precede it; r3 was folded into r4 and never cut). Each release carries three assets:

| Asset | Consumed by |
| --- | --- |
| `tessel-restore.tar.gz` | `t2 restore` — full bootloader + image, the destructive recovery path |
| `tessel-update.tar.gz` | `t2 update` — the sysupgrade path |
| `tessel-25.12-PROD-node8-rN.bin` | manual `--openwrt-path` flashing |

**Asset names are load-bearing.** `t2 restore` resolves
`releases/latest/download/tessel-restore.tar.gz` by default, so every release must publish that
exact filename. r1/r2 shipped `new_build_*.tar.gz`, which does *not* satisfy the default URL.

**The update feed.** `releases/builds.json` in this repo is the manifest `t2 update` reads (see
`t2-cli/lib/remote.js`, `BUILDS_JSON_URL`). Two constraints, both easy to get wrong:

- `sha` must equal the device's `/etc/tessel-version` **exactly** (trimmed). That file is stamped at
  build time from the commit the image was built from.
- `version` must be semver-valid, and prerelease identifiers need a **dotted numeric** part.
  Use `25.12.5-r.4`, not `25.12.5-r4` — the latter sorts `r10` below `r2` alphanumerically, so the
  feed would silently stop offering upgrades after the ninth respin.

**Blocker: this repository is private.** `t2-cli` fetches both the feed and the release assets
anonymously with plain `request` and no auth, so today both 404 for everyone. Verified directly —
`raw.githubusercontent.com/aaronpowell/tessel-2-revive/main/releases/builds.json` and the release
asset URLs all return 404 unauthenticated. **The feed cannot work for anyone until the repo is
public.**

Until then, override the endpoints or pass explicit paths:

```powershell
# Point at any reachable mirror
$env:T2_BUILDS_JSON_URL = 'http://127.0.0.1:8765/builds.json'
$env:T2_RESTORE_URL     = 'http://127.0.0.1:8765/tessel-restore.tar.gz'

# ...or bypass the feed entirely
node .\bin\tessel-2.js update `
  --firmware-path <path>\firmware.bin `
  --openwrt-path  <path>\sysupgrade.bin
```

**Verifying a local mirror — hash the bytes you actually served.** A stale HTTP server from an
earlier flash can still hold `127.0.0.1:8765` while a new one binds only the IPv6 wildcard, so
requests silently hit the *old* content and you "gate" an image you never flashed. This happened
once during the r4 work and was caught only because the served `Content-Length` was ~180 bytes short
of the file on disk. Always download from the URL and hash **that**, not the file you meant to
serve.

---

## `t2 update` loses device configuration

**Status:** 🔄 Host-side cause fixed; **image-side cause open.**

`t2 update` logs "Configuration is saved during update" and then returns a board with no WiFi
credentials and no provisioned SSH key. There were **two independent causes**, and the first
completely masked the second.

**Cause 1 — t2-cli misdetected the sysupgrade era. FIXED** (`t2-cli` `2296f56`).

`fixOldUpdateScripts()` decides whether to overwrite the device's `/lib/upgrade/common.sh` with a
bundled 2015 copy by grepping `/rom` for `do_upgrade_stage2`. 18.06 moved that logic out of
`common.sh`; **21.02 moved it again**, out of `common.sh` entirely and into `/lib/upgrade/stage2`
and `/lib/upgrade/do_stage2`. The grep therefore finds nothing on 25.12 and classifies a modern
image as *legacy*.

The flash still succeeds — `do_stage2` calls `default_do_upgrade`, which the legacy copy also
defines — which is exactly why this went unnoticed. But the two implementations key off different
variables:

```sh
# modern  /lib/upgrade/common.sh:312
[ -n "$UPGRADE_BACKUP" ] && ... mtd -j "$UPGRADE_BACKUP" write - firmware
# legacy  t2-cli/resources/openwrt/common.sh:221
[ "$SAVE_CONFIG" -eq 1 ] && ... mtd -j "$CONF_TAR"       write - firmware
```

The modern ramfs exports only `UPGRADE_BACKUP`. Under the legacy copy the config tarball is never
appended, preinit finds no `/sysupgrade.tgz`, and the overlay comes up empty.

The fix widens the probe to accept `/lib/upgrade/do_stage2`, `/lib/upgrade/stage2`, or an
`UPGRADE_BACKUP` reference as conclusively modern. Confirmed on hardware — the old expression
returns `LEGACY`, the new one `MODERN`, and `Modern sysupgrade detected` now appears in the log.

> **The lesson worth keeping:** this heuristic had *already* been fixed once in this project (at the
> 19.07 hop) and was still wrong, because 18.06 and 21.02 moved the same logic to two different
> places. Detecting an image's era by grepping for a function name is a trap — it needs re-fixing
> at every release that reorganises the upgrade scripts.

**Cause 2 — `98-tessel-wifi` clobbered restored WiFi credentials. FIXED in r5** (`ab51d6a`).

uci-defaults live in the squashfs, so after a sysupgrade — when the overlay is fresh — every script
in `/rom/etc/uci-defaults/` runs again. `98-tessel-wifi` sets `ssid`/`key`/`disabled`
**unconditionally**, and it runs *after* preinit has restored `/sysupgrade.tgz`. It therefore
overwrites the user's real credentials with the `tessel-unconfigured` placeholder and
`disabled='1'`.

Proven directly on hardware, without a reflash:

```
uci set wireless.@wifi-iface[0].ssid=PROOF-SSID; ...disabled=0; uci commit wireless
BEFORE: ssid=PROOF-SSID          disabled=0
sh /rom/etc/uci-defaults/98-tessel-wifi
AFTER : ssid=tessel-unconfigured disabled=1
```

Corroborated end-to-end by a real `t2 update --force` with Cause 1 fixed: the
`/etc/sysupgrade.conf`-listed marker file **survived**, `/etc/dropbear/authorized_keys` **survived**
(391 B) — so backup/restore is now working — but the wireless stanza came back at image defaults and
`wlan0` did not exist. Losing *only* the wireless config is the signature of a post-restore clobber,
not a failed backup.

**Fix (shipped in r5):** the credential and enable lines in `build/openwrt-incremental/build.sh` are
now guarded so they seed only a genuinely unconfigured radio, while the structural settings (mode,
network, ifname, channel, vendorid, LAN, firewall, umdns) stay unconditional and idempotent.
`encryption` is inside the guard too, so a user on an open or WPA3 network is not forced back to
`psk2`.

The guard keys off the **current `ssid` value**, not a marker file. That matters twice over: a
marker written to the overlay is useless because the overlay reset is precisely the event it must
survive, and an already-configured r≤4 board never wrote a marker at all — so on the r4→r5 update
the ssid value is the *only* thing that can distinguish "the user's network" from "unconfigured".
The values treated as unconfigured are empty, `OpenWrt`, and `tessel-unconfigured`. `OpenWrt` is
required: `/lib/wifi/mac80211.uc:112` generates `ssid='OpenWrt'` when the board has no default
(there is no `ssid` key in `/etc/board.json`), so a genuinely fresh flash carries it before this
script has ever run. Without that arm, a clean flash would not land on the placeholder + radio-off
posture. The trade-off is that a user whose real network is literally named `OpenWrt` gets re-seeded
on update.

`99-tessel-hostname` had the same bug and is fixed the same way — it re-asserted the generated
hostname on every new rootfs, which would silently undo `t2 rename` on every update. It now
re-stamps only an empty hostname, `OpenWrt`, or a prior auto-stamp (a `tessel-…` name ending in this
board's stable factory-MAC suffix), so a deliberate rename survives while the auto-stamp still
follows the release.

**Gated on hardware by a real r4→r5 `t2 update --force`** — the meaningful test, since r4 wrote no
marker. Everything survived: `ssid`, the WPA key, `encryption`, `disabled='0'`, the custom hostname
`tessel-lab-bench` set via `t2 rename`, `/etc/dropbear/authorized_keys` (391 B, md5 unchanged at
`7841d7e26013428a219fec030b0fd481`) and the `/etc/sysupgrade.conf`-listed marker file. The board
**rejoined WiFi unattended at the same IP on channel 11**, `/etc/tessel-version` read `ab51d6a`, and
`t2 run --lan` deployed and ran blinky to completion. All of it survived a power cycle.

The guard was then proven directly in **both** directions against the shipped `/rom` scripts:

```
# real config -> preserved
BEFORE: ssid=My Home WiFi        disabled=0 host=tessel-lab-bench
sh /rom/etc/uci-defaults/98-tessel-wifi ; sh /rom/etc/uci-defaults/99-tessel-hostname
AFTER : ssid=My Home WiFi        disabled=0 host=tessel-lab-bench

# unconfigured -> still seeds (so the guard is not a no-op)
BEFORE: ssid=tessel-unconfigured disabled=0 host=OpenWrt
AFTER : ssid=tessel-unconfigured disabled=1 host=tessel-v25-12-5-node8-r5-5787
```

---

## OpenWrt upstream uplift

**Status:** ✅ **COMPLETE.** Built, flashed, and hardware-validated end-to-end at
**OpenWrt 25.12.5 / kernel 6.12.94**, first released as `v25.12.5-node8-r1` and current at
`v25.12.5-node8-r5`.

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

**Fixed in r4 — `wireless.radio0.channel` was pinned to `1`.** OpenWrt's `wifi detect` writes a
fixed channel, which is right for an AP and wrong for a station: the radio parked on channel 1 and
never saw APs on 6 or 11. `wpa_supplicant` logged no association attempt at all and `iwinfo`
reported `Channel: 0` with the board's own MAC as the access point, so it read as a driver fault
rather than a config one. `98-tessel-wifi` now sets `channel='auto'`, which lets the station follow
whatever channel the joined network is on.

**Validated end-to-end on a clean r3 flash** (`4f3ad0c`), not just a live-patched board: every
`uci-defaults` script applied on first boot, the board joined the network, DHCP issued a lease with
the `Tessel 2` vendor class on the *first* request, `t2 list --lan` and `t2 provision` found and
authorized it, `t2 run index.js --lan` streamed `BLINK 1..24` with the LEDs physically confirmed,
and association, address and hostname all survived a power cycle.

**Re-gated on a clean r4 flash** (`2319761`) to prove the channel fix: from a factory-fresh flash,
with no manual `uci` intervention, the board associated on **channel 11** — the case r3 could not
do — took a lease, and ran blinky over WiFi, all of which survived a power cycle.

Note that after `t2 restore` the USB data interface does not always re-enumerate across a power
cycle; LAN/SSH still works, so a USB timeout here is not a boot failure. A freshly restored board
also needs a minute or so before it answers on USB — until then `t2 list` reports
`LIBUSB_TRANSFER_STALL`, which is the board still booting, not a flash failure.

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
