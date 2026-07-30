# OpenWrt Incremental Upgrade — Progress & Learnings

**Last updated:** 2026-07-17
**Status:** 🏁 **OS UPLIFT COMPLETE — the full incremental ladder 15.05 → 25.12 is HARDWARE-VALIDATED END TO END.** The device now boots **OpenWrt 25.12.5 / kernel 6.12.94** (the current actively-maintained branch). The final hop (25.12, k6.12) was validated on 2026-07-17: image `5B6D671F…` (6,488,344 B, sub-session commit d969587) flashed clean and passed the full gate — `dd mtd5` md5 `b18a8360…` (≠ all-0xFF), mtd5@0=`hsqs`, `VFS: Mounted root (squashfs filesystem) readonly on device 31:5` (no panic), `squashfs: version 4.0`, `RF chipset 7620 detected`, `/dev/spidev1.0` present, and **spid[1509] launched `514 513`** (gpio-base resolver found base=512 at k6.12) + usbexecd[1571] steady at boot with **no `invalid GPIO`**. Both k6.6-era fixes carried forward to k6.12 unchanged in intent: the `822` shared-SPI-reset-once guard (6.12 variant with the `devm_spi_register_controller` trailing context) and the base-agnostic spid-start resolver; plus the build.sh version→patches map split (`v24.10.*→patches-6.6` / `v25.12.*→patches-6.12`) and a byte-identical CS1 patch in patches-6.12. **The incremental method held every hop, and libgpiod was never needed anywhere on the path.** The phase that followed — building a **production image** (DIAG/WiFi-AP diagnostics dropped, **node 8.11.3** soft-float mipsel 24kec + the **tessel runtime** added so `t2 run`/`t2 push` work, then WiFi confirmed) — is also **complete and released**; it is documented in [`production-image-and-release.md`](production-image-and-release.md), with the remaining fixes (LED sysfs path, WiFi channel, `t2 update` config preservation) recorded in [`gaps-and-risks.md`](gaps-and-risks.md). This document stops at the OS ladder.

This document captures what the Tessel 2 revival effort has learned while walking the device
forward from its 2015 factory image, one OpenWrt release at a time. It is the "so we can iterate
again" record: the working strategy, the fixes that landed, the tooling we built, and the
blockers still ahead. For the *risk* of stopping here, see
[`risk-assessment-openwrt-18.06.md`](./risk-assessment-openwrt-18.06.md). For the general
not-upgrading analysis, see [`security-threat-assessment.md`](./security-threat-assessment.md).

---

## 1. Strategy: incremental hops, not a one-shot jump

The original plan was a single leap to **24.10** (kernel 6.6). That flashed and booted but left
`t2-cli` unable to connect, with no way to see *why* — the only diagnostic channel (the `spid`
bridge over USB) was itself the thing under test. It was a black box.

We pivoted to a **cautious hop-by-hop uplift**, validating each release on real hardware before
moving on. The end target is now **25.12** (kernel **6.12**, released March 2026) — the current
**actively-maintained** branch. (24.10 was the original target but EOLs **Sept 5, 2026**; 22.03 and
23.05 are already EOL, so they're stepping stones only.)

```
15.05 → 17.01 → 18.06.9 → 19.07 → 21.02.7 → 22.03 → 23.05 → 24.10 → 25.12
 k3.18   k4.4    k4.14      k4.14   k5.4       k5.10   k5.15   k6.6    k6.12
factory   ✅      ✅         ✅      ✅(here)    next     …       …    END (maintained)
```

Each hop isolates a **single delta**, so when something breaks the cause is bounded and
diagnosable. This is what turned the 24.10 "black box" into a series of concrete, fixed bugs.

### Hop status

| Hop | Release | Kernel | Build | Flash | Boots | Bridge (spid) | `t2 list --usb` | Verdict |
|----:|---------|--------|:----:|:-----:|:-----:|:-------------:|-----------------|---------|
| 0 | 15.05 (factory) | 3.18 | — | — | ✅ | ✅ | (factory) | baseline |
| 1 | 17.01 (LEDE) | 4.4 | ✅ | ✅ | ✅ | ✅ | `USB␉LEDE` | ✅ **HW-validated** |
| 2 | 18.06.9 | 4.14.206 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt` | ✅ **HW-validated** |
| 3 | 19.07.10 | 4.14.275 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt` | ✅ **HW-validated** |
| 4 | 21.02.7 | 5.4.238 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt` | ✅ **HW-validated** |
| 5 | 22.03.7 | 5.10.221 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt` | ✅ **HW-validated** (spid up AT BOOT, wait-loop fix) |
| 6 | 23.05.6 | 5.15.189 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt` | ✅ **HW-validated** (spidev whitelist fixed → node reappears) |
| 7 | 24.10.0 (k6.6) | 6.6.73 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt`¹ | ✅ **HW-validated** — two fixes: (a) `822-…reset-shared-spi-block-once.patch` re-adds the `hw_reset_count` guard the devm refactor dropped → shared SPI reset pulses once → reads return real data (squashfs mounts, `dd mtd5`≠0xFF, `hsqs`); (b) spid-start resolves gpiochip base at runtime (`bgpio_init()` moved it 0→512) → spid launches `514 513`, no `invalid GPIO 2`. spid+usbexecd steady at boot |
| | | | | | | | | ¹ device bridge proven up on-device (spid+usbexecd steady, `/dev/spidev1.0`); host `t2 list` was in the usual post-console endpoint-stall (needs a power-cycle for a clean op), same as validated 23.05 |
| **8** | **25.12.5 (k6.12)** | 6.12.94 | ✅ | ✅ | ✅ | ✅ | `USB␉OpenWrt`¹ | ✅ **HW-validated — 🏁 END TARGET REACHED.** Both k6.6 fixes ported to patches-6.12 and PROVEN at 6.12.94: (a) 6.12 `822` reset-guard (with the `devm_spi_register_controller` rename context) → `dd mtd5` md5 `b18a8360…`≠0xFF, `hsqs`, `VFS: Mounted root (squashfs) 31:5`, `RF chipset 7620`; (b) spid-start base resolver → spid launches `514 513` (base=512), no `invalid GPIO`. spid[1509]+usbexecd[1571] steady at boot. build.sh map split v24.10→6.6 / v25.12→6.12 + patches-6.12 CS1. libgpiod never needed across the whole ladder |

---

## 2. The fixes that landed (per hop)

### Hop 1 → 17.01: the real first hard break is CS1 SPI-device registration

- **Symptom:** `spid` crash-loops; `/dev/spidev0.1` never created;
  dmesg `spi_master spi0: spi_device register error … /spi@b00/spidev@1`.
- **Root cause:** the coprocessor was declared as `spidev@1` (chip-select **1**) under the single
  `spi@b00` controller, whose mainline ramips driver exposes `num_chipselect=1` → the CS1 device
  is rejected → no node → `spid` has nothing to open. Only visible at **kernel runtime**;
  build-only analysis missed it entirely.
- **Fix** (sub-session commit `75d9cd5`): move the coprocessor to **`&spi1` (`spi@b40`)** as
  `spidev@0` → enumerates as **`/dev/spidev1.0`**; add pinmux patch
  `999-tessel-mt7620-spi-cs1.patch` making the `spi_cs1` group **pin 37 only**, which also frees
  pin 38 (the POWER/user2 LED) and fixes the `leds-gpio` probe.
- **Lesson:** the old "the only blocker is a 1-line `spid.sh` bus-number change" framing was
  wrong. This was a real, bounded DTS + pinmux fix — but still mechanical, not a rewrite.

### Hop 2 → 18.06.9: two t2-cli flash bugs, then clean

- **Blocker A — cross-version sysupgrade compat gate.** `t2 update` transferred the image and
  printed "Finished," but the device stayed on 17.01. OpenWrt sysupgrade (17.01+, absent in
  15.05) compares the running board identity against the image's appended `supported_devices`
  and **refuses without writing** on mismatch. The operative check on 18.06+ is `fwtool` comparing
  the running DT `compatible = "tessel,tessel2"` against the image `supported_devices = ["tessel"]`.
  (The older, related signal is `/tmp/sysinfo/board_name = "generic"` — the Tessel has no
  `board.d` entry.) This is exactly why factory(15.05)→17.01 flashed clean but 17.01→18.06 refused.
- **Fix A** (`repos/t2-cli/lib/tessel/update.js`): opt-in env-gated force — when
  **`T2_FORCE_FLASH`** is set, splice `-F` into the sysupgrade command (mirrors the existing
  `T2_RESTORE_URL` override convention; default behaviour unchanged). Forcing is safe: it's the
  correct ramips/mt7620 tessel build, only cosmetic metadata trips the gate, and restore recovery
  is always available.
- **Blocker B — t2-cli clobbers `/lib/upgrade/common.sh`.** With Fix A in place, 19.07 (and by
  extension every 18.06+ flash) still **silently no-op'd**: transfer OK, reboot back to the old
  image, `/tmp/openwrt.bin` gone. Root cause: `fixOldUpdateScripts()` overwrote the running
  system's `/lib/upgrade/common.sh` with a bundled **Chaos-Calmer-era** copy before *every*
  sysupgrade. But 18.06+ refactored sysupgrade to pivot into a ramfs and moved the flash routine
  out to **`do_upgrade_stage2`** — so the clobber **deleted `do_upgrade_stage2`** → sysupgrade
  called an undefined routine → rebooted without writing. (17.01→18.06 worked only because 17.01
  matched the legacy file's era.) This would have bitten **every** hop, including the 24.10 jump.
- **Fix B** (`repos/t2-cli/lib/tessel/update.js`): made `fixOldUpdateScripts()` **version-aware** —
  read the pristine `/rom/lib/upgrade/common.sh`; if it contains `do_upgrade_stage2` (modern),
  restore that over any clobbered overlay copy and skip the legacy override. Self-heals an
  already-clobbered device. Also added `[sysupgrade]` stdout/stderr logging (gated on
  `T2_FORCE_FLASH`/`T2_UPDATE_VERBOSE`) so device-side sysupgrade output is no longer swallowed by
  the USB daemon — this is what finally made Blocker B visible.
- **Result:** 18.06.9 boots, CS1 fix holds on k4.14, `spid` + `usbexecd` up, POWER LED steady,
  `t2 list --usb` → `USB␉OpenWrt`. **All gate items pass.**

### Hop 2/3 CS1 port to kernel 4.14 is release-general

The 17.01/k4.4 fix renamed the pin group; on k4.14 the **stock** `mt7620n.dtsi` already names the
group `"spi refclk"`, so the k4.14 patch is a **single-line trim** (`FUNC("spi refclk",0,37,3)` →
`(…,37,1)`) that keeps the name and just makes pin 37 the second SPI CS. The **same patch dropped
into 19.07 unchanged** — strong evidence the CS1 fix is general across the k4.14 line.

### Hop 3 → 19.07: builds, flashes, and now boots — ✅ HW-validated (2026-07-16)

After Fixes A + B, 19.07 **genuinely writes** (the sysupgrade log reaches
`Commencing upgrade. Closing all shell sessions.` — the line we never used to reach). It first
**kernel-panicked at t=0.52 s** because the "firmware" MTD partition was never split into
kernel+rootfs (no root device). Root cause + the correct fix (name-based split via
`CONFIG_MTD_SPLIT_FIRMWARE=y`, bare DTS) are in §4 — the firmware partition now splits and the
device boots to full userspace with the bridge up. See §4.

### Hop 4 → 21.02.7 (kernel 5.4): the pinctrl DT-binding migration — ✅ HW-validated (2026-07-16)

The first kernel-5.x hop. Scoping the real v21.02.7 tree **shrank** the expected work: the two big
k5.x breaks we had braced for turned out **not** to fire at 5.4 —

- **spidev whitelist — not needed at 5.4.** `spidev_probe()` still only emits a *non-fatal* WARN
  (`buggy DT: spidev listed directly in DT`) and creates `/dev/spidev1.0` anyway, same as k4.14.
  Deferred to whichever later hop hard-refuses.
- **libgpiod / GPIO numbering — not needed at 5.4.** `CONFIG_GPIO_SYSFS=y` is still default, so
  `/sys/class/gpio` works and spid's sysfs-GPIO code runs unchanged; `gpiochip0` base=0 keeps the
  global numbers (SYNC=1, IRQ=2) correct. Deferred to the hop that drops sysfs GPIO.
- **firmware mtdsplit — non-issue.** `CONFIG_MTD_SPLIT_FIRMWARE=y` is *default* in
  `mt7620/config-5.4` (19.07 was the anomaly), so the bare `label="firmware"` partition splits.

So the only bridge-critical deltas over the 19.07 recipe were the **CS1 pin-37 patch ported to
`patches-5.4`** (mechanical — the `refclk_grp` context is byte-identical between mainline 4.14 and
5.4) plus **one pinmux fix**, described next. (Two harness-only deltas were also needed: the
Dockerfile gained `python3`/`python3-distutils` — 21.02 `make defconfig` requires Python ≥3.5 and
this is the first hop to drop Python 2 — and the ramips image recipe was rewritten in 21.02 so the
overlay `Device/tessel` now sets `SOC := mt7620n` + `DEVICE_DTS := Tessel`.)

**The bridge break: a pinctrl DT-binding migration (not GPIO removal, not renumbering).** The first
flashed image booted on 5.4.238 but `spid` crash-looped: `GPIO export write: Invalid argument`, with
the kernel logging `rt2880-pinmux: pin 2 is not set to gpio mux ... status -22`. On-device
`pinmux-pins` showed io1 (SYNC) and io2 (IRQ) — the MT7620 **"i2c"** pinmux group — as
`MUX UNCLAIMED`, so the strict k5.4 pinctrl rejected spid's export.

Root cause is a **"correct-DTB ≠ correct-runtime"** trap (same shape as the 19.07 `denx,uimage`
regression). At k5.4 the ramips rt2880 pinmux driver moved to `drivers/staging/mt7621-pinctrl` and
switched its `.dt_node_to_map` from the ralink-specific parser (which reads
`ralink,group`/`ralink,function`) to the **generic** `pinconf_generic_dt_node_to_map_all` (which
reads `groups`/`function` and *ignores* `ralink,*`). Our overlay `Tessel.dts` `state_default` had
listed the i2c group as gpio since 17.01 — but only with the legacy `ralink,*` spelling. At 5.4 the
generic parser produced **zero** mux maps → i2c never muxed to gpio → spid's export EINVALs.

**Fix (sub-session commit `81710cc`):** dual-spell the `state_default`/`default` node so it carries
**both** bindings —

```dts
default {
    ralink,group    = "ephy","wled","pa","i2c","wdt","uartf";
    ralink,function = "gpio";
    groups          = "ephy","wled","pa","i2c","wdt","uartf";   /* the k5.4 generic-parser spelling */
    function        = "gpio";
};
```

The k4.14 parser reads `ralink,*` and ignores the generic pair; the k5.4 generic parser reads
`groups`/`function` and ignores `ralink,*`. One overlay DTS stays correct on **every** hop
(17.01/18.06/19.07 unchanged; 21.02+ now works) — no version-gating.

**Hardware verdict (clean console capture after reflash of the fixed image):**

- `pinmux-pins`: `pin 1 (io1): function gpio group i2c` and `pin 2 (io2): function gpio group i2c`
  (were `MUX UNCLAIMED`). ✅
- `pgrep -l spid` → `1500 spid`; `pgrep -l usbexecd` → `1560 usbexecd` — both steady, single
  `spid[1500]: Starting`, no `GPIO export write` error, no procd restart storm. ✅
- `echo 2 > /sys/class/gpio/export` → **EBUSY** ("Resource busy") — i.e. spid has *already* claimed
  gpio1+gpio2. A positive signal, not the old EINVAL.
- Solid blue POWER LED; `wlan0` up and forwarding; `uname -r` 5.4.238 / OpenWrt 21.02.7 r16847.
- Host `t2 list --usb` → **`USB␉OpenWrt`**. ✅

21.02.7 and now **22.03.7 (k5.10, spid up at boot via the wait-loop fix)** are validated; the next hop is **23.05 (k5.15)** — the hop the deferred spidev whitelist break is expected to fire.

#### WiFi status at 21.02 — the reason we pushed past 18.06

The whole point of getting off 18.06 was WiFi, and this hop is where that pays off. Read directly
off the running 21.02.7 device:

- **Radio works.** `wlan0` is up in AP mode and broadcasting (`iw dev` → `Interface wlan0 / type AP /
  ssid Tessel-Diag`); the rt2800 radio calibrates and `wlan0` forwards in the boot log. (The earlier
  "WiFi not broadcasting / ERR faint" was the **19.07 reboot loop**, not a radio fault — it's gone
  now that the device boots.)
- **The WPA stack jumped two of the three 18.06 WiFi gaps** (threat **T2 remainder** in the 18.06
  risk doc):
  - **WPA3 / SAE / PMF — now available.** The image ships **`wpad-basic-wolfssl` (2020-06-08)**, not
    18.06's `wpad-mini`. The `-wolfssl` basic variant supports **WPA3-Personal (SAE)**, **OWE**, and
    **802.11w PMF**. So "WPA2-only, no SAE/PMF" is no longer a *capability* limit — it's just the
    DIAG image's `encryption='psk2'` config choice (a one-line uci change to `sae`/`sae-mixed`).
  - **FragAttacks — patched (verified).** FragAttacks is overwhelmingly a **mac80211/driver**
    issue (fragment cache, mixed-key, A-MSDU, plaintext-accept — CVE-2020-24586/24587/24588 +
    CVE-2020-2613x/2614x), not a hostapd one. On this device the WiFi stack is **not** the base
    kernel 5.4 — it's OpenWrt's **`mac80211` backports package `5.10.168`** (Feb 2023), which drives
    the `rt2800` radio. The FragAttacks fixes landed upstream in **May 2021** (≈5.10.37/38), so a
    5.10.168 backport is ~22 months past them. Confirmed at runtime: `dmesg` → `Loading modules
    backported from Linux version v5.10.168`, and `kmod-mac80211`/`kmod-rt2800-* = 5.4.238+5.10.168`.
    (The `wpad` base tag `2020-06-08` is a red herring — the FragAttacks defenses are in mac80211,
    which is the 5.10.168 backport.)
  - **Still inherent (version-independent):** the radio bypasses any wired VLAN isolation. That's a
    deployment control, not something a version bump fixes.

**Net:** for the *WiFi-specific* risks that motivated leaving 18.06, 21.02 materially closes them —
the radio is functional and WPA3-Personal is a config away. Remaining WiFi to-dos are configuration
+ validation (enable SAE/PMF in the production image and validate AP **and** client modes), not a
missing capability. Note 21.02 is itself EOL (branch retired ~Feb 2023), so the *supported-branch*
goal points onward to the end target **25.12** (24.10 EOLs Sep 5 2026; 22.03/23.05 already EOL).

### Hop 5 → 22.03.7 (kernel 5.10): a spid boot-ordering race — RESOLVED, HW-validated at boot (2026-07-16)

22.03 was scoped as a near-mechanical hop and the source scan was right: every k5.x break stayed
paid down (spidev still *warn-but-creates* `/dev/spidev1.0`; `CONFIG_GPIO_SYSFS=y` still default;
mtdsplit `firmware` still name-splits; the dual-binding pinmux from 21.02 still muxes i2c→gpio). The
only new patch was the CS1 pin-37 trim ported to `patches-5.10` (byte-identical `refclk_grp`, applied
clean). Image `1B0F7479…` flashed via the repackaged-restore path and **booted 22.03.7 r20341 /
uname 5.10.221**, firmware split into kernel+rootfs+rootfs_data, `/dev/spidev1.0` present, SPI in
mode3 with zero register error.

**But the POWER LED blinked and `t2-cli` couldn't connect** — `pgrep spid`/`usbexecd` were **empty
after boot**. Root cause (a boot-*timing* property no source diff could reveal):

- At 22.03 **`spidev` is a loadable kernel module** (`spidev(+)` in *Modules linked in*) that
  initializes **~13 s into boot** (the `spidev.c:750` "buggy DT" WARN timestamp). At 21.02 it was
  built-in, so `/dev/spidev1.0` existed the instant userspace came up.
- Our overlay `spid-start` does `SPIDEV="$(ls /dev/spidev* | head -n1)"` and immediately
  `exec spid …` — **no wait**. `spid.init` is `START=60` + procd `respawn`.
- So at boot `spid-start` runs *before* t≈13 s, `/dev/spidev*` doesn't exist yet, `spid` fails to
  open the device and exits. procd respawns it rapidly, trips the **respawn throttle** (~5 fast
  failures) and **gives up permanently** — before the module ever loads. Nothing restarts it once
  `/dev/spidev1.0` finally appears.
- Proof it's *only* ordering: a manual `/etc/init.d/spid start` (once the node exists) →
  `spid[1503]` + `usbexecd[1567]` steady, **POWER LED goes solid**, and host `t2 list --usb` →
  `USB␉OpenWrt`. The daemon works; it just never got a live device at boot.

**Fix (single, all-hop-safe, on the build side):** add a bounded wait-loop to overlay
`tessel-tools/files/spid-start` that polls `ls /dev/spidev*` for up to ~30 s before `exec spid`.
At ≤21.02 (spidev built-in) it passes on the first iteration; at 22.03+ it waits the ~13 s. Preferred
over bumping procd's respawn retries because it's deterministic and doesn't spam failed launches.
This will very likely be **required at 23.05 / 24.10 / 25.12 too** (spidev stays a module), so it
carries forward alongside the CS1 and dual-binding pinmux fixes. Rebuild + reflash pending; the
validation gate is that spid comes up **at boot** with no manual start.

**RESOLVED — ✅ HARDWARE-VALIDATED AT BOOT (2026-07-16).** Rebuilt with the wait-loop (sha
`D6E4FFD5…`, supersedes `1B0F7479…`) and reflashed via repackaged-restore. On a normal (warm) boot:
`spid[1322]` + `usbexecd[1385]` both steady **at boot with NO manual start**, single `Starting` (no
respawn storm), POWER LED solid within ~20 s and stays solid, `/proc/mtd` splits (mtd4/5/6),
`/dev/spidev1.0` present, host `t2 list --usb` → `USB␉OpenWrt`. The wait-loop carry-forward fix is now
hardware-proven. Console evidence: `soc-2203-steady.log`.

Two watch-items observed (neither a bridge blocker, both logged for follow-up):
- **First-boot-after-flash only** is pathologically slow (~128 s to spid) because the empty
  `rootfs_data` jffs2 overlay is formatted on first boot (+ entropy starvation), and a **one-time
  `modprobe` kernel Oops** fired at ~191 s uptime (`epc 0x70263490`, "Bad address in epc", during the
  mac80211/wifi module-load window) → one reboot. The **second boot is fast and clean — the panic did
  NOT recur** (steady-boot `dmesg` Oops/panic count = 0). Treated as an entropy/timing artifact of the
  entropy-starved first boot; flag if it ever appears on a warm boot.
- **rt2800 wifi** logged `BBP/RF register access failed, aborting` + `RF RX busy in LOFT IQ
  calibration` on that slow first boot (wlan0 still entered forwarding). Wifi was validated at 21.02;
  whether rt2800 at k5.10+ has a real regression needs re-confirming before the final production image
  (the end goal is a working-wifi device). Not gated on the bridge hop.

### Hop 6 → 23.05.6 (kernel 5.15): the deferred spidev whitelist fires — and is fixed (2026-07-16)

This is the **localization payoff** hop. Since 19.07 we tracked a deferred break: the mainline
`drivers/spi/spidev.c` was being tightened to reject a literal `compatible="spidev"` in DT. It finally
turned **fatal at k5.15** — `spidev_probe()` → `spidev_of_check()` returns `-EINVAL` ("spidev listed
directly in DT is not supported") for any node whose compatible is (or contains) `spidev`, so
`/dev/spidev1.0` is never created and the bridge can't open the coprocessor.

**Fix (version-gated, single delta):** rewrite the coprocessor node's compatible from `"spidev"` to
`"rohm,dh2228fv"` — a whitelisted no-op DAC part that the spidev driver binds as a generic spidev. The
`/dev` node name is always `spidevBUS.CS` regardless of compatible, so it stays `/dev/spidev1.0` and
`spid` + `spid.sh` args are untouched. Must be **k5.15+ only**: `device_property_match_string` matches
`spidev` *anywhere* in the list (so dual-listing still hard-fails), and the validated ≤k5.10 hops bind
via `modalias=="spidev"` (they need the bare string) — no single compatible works both sides, so the
build harness gates it by version. Also mechanical: the CS1 pin-37 patch re-paths to
`drivers/pinctrl/ralink/pinctrl-mt7620.c` (pinmux tables migrated out of `arch/mips`), and the build
container needed gcc-8 (23.05's M4 1.4.19 wants `-std=gnu17`).

**✅ HARDWARE-VALIDATED AT BOOT.** Image `9331B38C…` (folded wait-loop + `rohm,dh2228fv` + CS1-5.15,
commit 23f13fe) flashed via repackaged-restore. Steady boot: boots **23.05.6 / uname 5.15.189**,
`/proc/mtd` splits (mtd4/5/6), **`/dev/spidev1.0` REAPPEARS** (`crw 153,0` — the decisive proof the
whitelist fix took; a bare `spidev` would be *absent* here), `dmesg` shows **no "spidev … not
supported"** error, `spid[1276]` + `usbexecd[1337]` steady **at boot** with a single `Starting`, no
kernel panic, host `t2 list --usb` → `USB␉OpenWrt`. Bonus: the wifi AP `phy0-ap0` entered forwarding
(encouraging vs the 22.03 first-boot rt2800 register errors). Same one-time slow first-boot (overlay
format) as 22.03; the warm boot is clean. Console evidence: `soc-2305-steady.log`. libgpiod is still
deferred (GPIO_SYSFS stays default at k5.15).

**Roadmap correction (2026-07-16, from the 24.10 source scoping):** the long-deferred **libgpiod port
is NOT needed at 24.10 or 25.12** either. `CONFIG_GPIO_SYSFS` is *deprecated but still present* in
linux 6.6.73 and OpenWrt keeps `CONFIG_GPIO_SYSFS=y` in `generic/config-6.6`, so spid's
`/sys/class/gpio` export (global nums 2/1) works unchanged all the way to the 25.12 end target. The
earlier premise that "sysfs GPIO is removed at k6.6 → libgpiod becomes mandatory" is
**false** — sysfs GPIO survives the entire remaining path. The original full-jump 24.10 bridge failure
was never sysfs-GPIO removal; it was the *stack* of breaks (spidev whitelist hard-refuse, the spid
boot-race, CS1 non-registration, pinmux) that we've since isolated and fixed one hop at a time. That
leaves 24.10 as two mechanical harness deltas (a `v24.10.*→patches-6.6` map and the CS1 patch re-pathed
to `drivers/pinctrl/mediatek/pinctrl-mt7620.c`, struct `mtmips_pmx_func`) plus the validated
carry-forward ledger — no libgpiod anywhere.

**Second roadmap correction (2026-07-16, from the 25.12 source scoping): 25.12 is kernel 6.12, NOT
6.6.** Verified directly against `openwrt-25.12`: `target/linux/ramips/Makefile` has
`KERNEL_PATCHVER:=6.12` (latest tag v25.12.4, linux **6.12.87**, mt7620 has `config-6.12`, no
`config-6.6`). The prior roadmap assumed 25.12 = k6.6 and would reuse the 24.10 `patches-6.6` deltas —
so the current `build.sh` `v25.12.*→patches-6.6` map is a **latent bug** (the CS1 patch would install
into an ignored dir → CS1 break would silently return); it must split into
`v24.10.*→patches-6.6` / `v25.12.*→patches-6.12`. Everything else still holds at 6.12.87
(source-verified): **libgpiod still not needed** — `generic/config-6.12` has `CONFIG_GPIO_SYSFS=y` and
`# CONFIG_GPIO_CDEV is not set`, so sysfs is the *only* userspace GPIO iface at 6.12 (the no-libgpiod
conclusion is now closed for the entire 6.6 **and** 6.12 path); spidev whitelist still `-EINVAL`s literal
"spidev" and still lists `rohm,dh2228fv` (version-gate auto-fires, 6012≥5015); CS1 `refclk_grp =
FUNC("spi refclk",0,37,3)` at the same mediatek path, struct `mtmips_pmx_func`, byte-identical context
→ the CS1 patch copies verbatim into `patches-6.12`; switch still swconfig; mtdsplit harness-injected;
host prereqs (gcc≥8 + python≥3.7) already satisfied. So 25.12 is a near-trivial mechanical hop once
24.10's root-mount fault is solved — but note the k6.6 squashfs-mount non-boot below may or may not
recur at k6.12 (different kernel; to be re-tested).

---

### Hop 7 → 24.10.0 (kernel 6.6.73): a NEW k6.6 break — SPI-NOR reads return all-0xFF (2026-07-16) → ✅ RESOLVED (2026-07-17)

> **✅ RESOLVED 2026-07-17 — FULLY HARDWARE-VALIDATED AT BOOT.** The sub-session's two-fix respin
> (`b0fa3f85…`, 6,095,660 B, commit 0af45fd) was flashed and passed the full on-device gate:
> boot log `VFS: Mounted root (squashfs filesystem) readonly on device 31:5` (the exact line that
> panicked before — squashfs mounts, no VFS panic, no reboot loop); `dd if=/dev/mtd5 bs=64k count=1 |
> md5sum`=`8c5383a8…` (≠ all-0xFF `09a1d434…`); `dd if=/dev/mtd5 bs=4 count=1 | hexdump`=`hsqs`
> (squashfs magic); wifi EEPROM read fixed (`loaded eeprom from mtd device "factory"` + `RF chipset 7620
> detected`, was `Invalid RF chipset 0x0000`); 24.10.0 / kernel 6.6.73; firmware splits mtd4/5/6;
> `/dev/spidev1.0` present (crw 153,0); **spid[1558] + usbexecd[1620] steady AT BOOT**; and the GPIO fix
> is confirmed by the launch args — spid runs as `spid /dev/spidev1.0 514 513 /var/run/tessel` (the
> resolver found gpiochip base=512 and passed base+2/base+1), with **zero `export_store: invalid GPIO 2`**
> in dmesg. Both fixes below are now hardware-proven. The historical diagnosis narrative is retained.

The 24.10 DIAG image (`552791AD…`, 6,095,660 B, commit 79343e5) built cleanly with the two scoped
harness deltas + full carry-forward, flashed cleanly (`Restore successful`), and the **kernel boots** —
but it is a **hard non-boot at the root-filesystem mount**, reboot-looping. This is a genuinely *new*
isolated break at kernel 6.6, and — importantly — **not** a repeat of the 19.07 no-split panic.

**What works (carry-forward intact):**
- u-boot loads the uImage@`0x50000`, decompresses `MIPS OpenWrt Linux-6.6.73`, `MIPS: machine is Tessel 2`.
- **The firmware partition SPLITS correctly** (so the `MTD_SPLIT_FIRMWARE=y` inject + mtdsplit both
  work at 6.6): `2 uimage-fw partitions found` → `mtd4 kernel` (`0x50000–0x2cdb24`) + `mtd5 rootfs`
  (`0x2cdb24–0x2000000`, *"doesn't start on erase-write boundary → force read-only"*);
  `mtd: setting mtd5 (rootfs) as root device`; `1 squashfs-split partitions found` → `mtd6 rootfs_data`
  (`0x620000–0x2000000`). Exact 22.03/23.05 layout. `spi spi0.0` + `spi spi1.0` both `force spi mode3`.
- `squashfs: version 4.0` registered; cmdline `rootfstype=squashfs,jffs2` (no `root=`, relies on the mtd auto-root).

**The failure (from `files/soc-2410-boot-full.log` / `soc-2410-squashfs-fail.log`):**
```
[0.724] Flash size not aligned to erasesize, reducing to 29888KiB
   … 61.6 seconds of TOTAL log silence — NO "SQUASHFS error:" line …
[62.358] jffs2: Cowardly refusing to erase blocks on filesystem with no valid JFFS2 nodes
[62.367] jffs2: empty_blocks 0, bad_blocks 0, c->nr_blocks 467
[62.374] VFS: Cannot open root device "" or unknown-block(31,5): error -5
[62.444] Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(31,5)
         Rebooting in 1 seconds..   → loops
```
**Prime suspect (initial, now SUPERSEDED):** an mtdblock / `mtd_blkdevs` read-path regression on the
unaligned-start "force read-only" rootfs partition. An **initramfs RAM-boot DIAG** (`f2dd3635…`,
9,437,461 B, commit 1c72791) — which roots in RAM and never mounts mtd5, giving a live shell over the
USB serial console — **disproved this and pinned the true cause** (see below).

**✅ CONFIRMED ROOT CAUSE (initramfs DIAG, on-device probes, 2026-07-16):
the Linux 6.6 SPI-NOR *data-read* path returns all-`0xFF` for the Tessel's s25fl256s — JEDEC-ID probe
works, but no read opcode actually returns flash data.** Evidence (`files/soc-2410-probe-*.log`):
- `md5(dd /dev/mtd5 bs=64k count=4)` = `09a1d434dbd7197e7c3af8a7c28ca38b`, **identical to host
  `md5(256 KiB of 0xFF)`** — the read returns pure erased-flash. `/dev/mtdblock5` returns the same, so
  the earlier "raw == block" match was *both paths returning 0xFF*, not proof the block layer is healthy.
- **Every** partition reads 0xFF: mtd0 (u-boot @`0x0`), mtd1 (@`0x30000`), mtd2 (factory @`0x40000`),
  mtd4 (kernel @`0x50000`), mtd5 (rootfs). **Address-independent → NOT 4-byte addressing.**
- The chip is nonetheless correctly probed: `spi-nor spi0.0: s25fl256s1 (32768 Kbytes)`, `force spi mode3`,
  4 partitions parse. **RDID works; data reads don't.**
- **u-boot reads flash fine** (`## Booting image at bc050000`, `raspi_read: from:50040 len:5ac6fb`,
  `Uncompressing Kernel Image ... OK`) — so the flash *contents* are intact; only the Linux read path is broken.
- `mount -t squashfs -o ro /dev/mtdblock5 /mnt` → `Invalid argument` (mtd5 offset 0 = `ff ff ff ff`, no
  `hsqs`), even though the built `.bin`'s squashfs is valid & dense (hsqs @ file `0x5AC73B`, bytes_used
  `0x350280`, 99.6 % non-0xFF).

**Every 24.10 symptom traces to this one fault:** the production non-boot (squashfs superblock reads
0xFF → no `hsqs` → `fill_super` never runs → silent mount fail → jffs2 fallback reads 0xFF via
`mtd_read` → "no valid JFFS2 nodes" → `(31,5) error -5` panic); AND the boot-log wifi error
`rt2800_init_eeprom: Invalid RF chipset 0x0000` (factory EEPROM read came back 0xFF) — a downstream
symptom, not an independent wifi break. The static "read path byte-identical 5.15→6.6" analysis was
correct about `rt2880_spi_transfer_one`/`spi_nor_read`; the regression is elsewhere — the read
opcode / dummy-cycle / **spi-mem capability** path between spi-nor and the ramips **spi-rt2880**
controller at k6.6 (idle-high 0xFF = data never clocked off MISO). **Fix target: the SPI-NOR read path,
NOT squashfs/mtdblock/timing.** Compare the WORKING 23.05/k5.15 spi-rt2880 + spi-nor read config to 6.6.

**⟳ EXACT MECHANISM PINNED (spi-nor debugfs `params`, `files/soc-2410-spinor-params.log`, 2026-07-17):**
the k6.6 spi-nor core selected the **4-byte NATIVE read opcode `0x13` (READ_4B), 0 dummy, 1S-1S-1S**,
with `flags = 4B_OPCODES | HAS_16BIT_SR` and `address nbytes = 4` — while the flash's own `capabilities`
table advertises the standard 1S-1S-1S read as opcode **`0x03`** (3-byte). SFDP is **empty** (0-byte file),
so these params come from the **static `s25fl256s1` flash_info entry, which carries `SPI_NOR_4B_OPCODES`**.
The ramips **rt2880 spi-mem PIO controller cannot emit the `0x13` 4-byte-opcode transaction**, so every
read (address-independent, since 0x13 is now used for ALL reads) returns 0xFF. RDID/`0x9F` has no address
phase → probe still works, which is exactly why the chip is detected but no data reads succeed. **Surgical
fix (sub-session): clear `SPI_NOR_4B_OPCODES` for this flash so the core uses enter-4B-address-mode (`B7h`)
+ the controller-friendly `0x03` read, OR make the rt2880 controller advertise it cannot do 4B ops so
spi-nor falls back. Diff `drivers/mtd/spi-nor/{core.c,spansion.c}` between the 23.05 (k5.15) and 24.10
(k6.6) trees around `SPI_NOR_4B_OPCODES` / `spi_nor_set_4byte_addr_mode` / `spi_nor_default_setup`.**

**✅ TRUE SOURCE ROOT CAUSE — SUPERSEDES the opcode hypothesis above (build sub-session, 2026-07-17;
pending hardware confirmation on the respin): k6.6 spi-rt2880 double-resets the SHARED SPI block.**
The MT7620 has TWO SPI controllers — `spi@b00` (flash) and `spi@b40` (coprocessor) — on ONE reset line
(both carry `resets=<&rstctrl 18>` / `reset-names="spi"`, confirmed in the decompiled DTB). OpenWrt's
out-of-tree `spi-rt2880.c` was refactored to devm APIs for 6.6 and **DROPPED the `hw_reset_count` atomic
guard** that 5.15 (and every validated hop) had, so `device_reset()` now fires **unconditionally per
probe**. Sequence: flash probes → resets the shared block → spi-nor RDID succeeds + the DT-based
partition split parses (that's why the log shows `s25fl256s1 (32768 Kbytes)` + `4 fixed-partitions`).
THEN the coprocessor controller probes → **re-pulses the shared reset → wipes the flash controller's
mode3/arbiter config** → every subsequent flash READ clocks against a reset block → **all-0xFF,
address- AND opcode-independent**. u-boot reads fine (single-threaded, only one probe). This is why the
byte-identical `rt2880_spi_transfer_one` analysis was correct — the regression is in `probe()`, NOT the
transfer fn. **The debugfs `0x13`/`SPI_NOR_4B_OPCODES` observation above is a TRUE but DOWNSTREAM detail
(the core did select 0x13); it is NOT the cause — the reset wipe fails any opcode, and the "clear
SPI_NOR_4B_OPCODES / force 0x03" idea was the wrong layer.** **Fix: `patches-6.6/822-SPI-rt2880-reset-
shared-spi-block-once.patch` re-adds the exact 5.15 atomic guard so the shared reset pulses once (the
hardware-validated 15.05–23.05 behavior); dry-run applies clean, no .rej.**

**Second, independent k6.6 break also observed:** `export_store: invalid GPIO 2` (repeating) — sysfs
GPIO export of global nums 2/1 is rejected because the **gpiochip base is no longer 0** at k6.6. 6.6's
`gpio-ralink.c` was rewritten onto `bgpio_init()`, which sets `gc->base = -1` (dynamic) and **ignores the
DT `ralink,gpio-base`** prop that pinned bank0 to base 0 through 5.15 — so the coprocessor lines are no
longer global 2/1. **Fix (spid-start): resolve bank0's base at runtime (the gpiochip whose label ends
`600.gpio`) and pass `base+2`/`base+1` to spid; when base==0 (every hop ≤23.05) it yields exactly `2 1`
→ all-hop-safe, no version gating.** Both fixes fold into ONE rebuild and gate at DIFFERENT stages, so a
single flash cleanly reveals both: read fix → device BOOTS (squashfs mounts, `/proc/mtd` real); GPIO fix
→ spid comes up (no "invalid GPIO"). **Both gates PASSED on the respin (`b0fa3f85…`) — see the RESOLVED
banner at the top of this section.** The device booted 24.10.0/6.6.73, squashfs mounted, reads returned
real data, and spid+usbexecd came up steady at boot with the runtime-resolved GPIO base (`514 513`).

**Method vindication:** a full jump straight to 24.10 would have produced this *same* non-boot with no
way to tell it apart from the (now-fixed) spidev/CS1/pinmux/boot-race breaks. Because those are all
isolated and validated on the earlier hops, this k6.6 root-mount fault stands alone as the single
remaining hop-7 delta.

---

### Hop 8 → 25.12.5 (kernel 6.12.94): 🏁 END TARGET — both k6.6 fixes carry forward, validated (2026-07-17)

The final hop. **25.12 is a real kernel bump to 6.12, not 6.6** (verified `KERNEL_PATCHVER:=6.12` on
`openwrt-25.12` ramips; latest tag `v25.12.5` → linux `6.12.94`, upstream bumped `.87→.94` since scoping).
Before building, the sub-session **source-verified that both k6.6 breaks persist at k6.12**:

- **SPI shared-reset:** `openwrt-25.12` patch `821` still calls `device_reset()` unconditionally in
  `rt2880_spi_probe()` → the `822` guard is **still required**. The only 6.12 driver delta is the
  trailing `devm_spi_register_master → devm_spi_register_controller` rename, so a **6.12-specific `822`**
  (patches-6.12/) carries that context. Verified in the built driver: guard at L406/L455, zero `.rej`.
- **GPIO base:** 6.12 `gpio-ralink.c` still uses `bgpio_init(...,NULL,0)` (`gc->base=-1`) → base off 0
  → the base-agnostic **spid-start resolver carries forward unchanged**.
- **CS1:** `pinctrl-mt7620.c` still has `mtmips_pmx_func refclk_grp = FUNC("spi refclk",0,37,3)` at 6.12 →
  **byte-identical CS1 patch** dropped into patches-6.12/ (37,3→37,1 trim).
- **Latent build.sh bug fixed:** the version→patches map was split `v24.10.*→patches-6.6` /
  `v25.12.*→patches-6.12` (+ `feed_branch v25.12.*→openwrt-25.12`), so the CS1 patch no longer silently
  installs into an ignored dir. Committed d969587.
- **Auto-carries confirmed at 6.12:** `GPIO_SYSFS=y` + `GPIO_CDEV` **not** set (no libgpiod), the
  `rohm,dh2228fv` spidev whitelist (DTB), `MTD_SPLIT_FIRMWARE=y` injected into `config-6.12`.

**Hardware gate — FULL PASS** (image `5B6D671F…`, 6,488,344 B; flashed clean, 17 s):
- **Read fix:** `dd if=/dev/mtd5 bs=64k count=1 | md5sum` = `b18a8360e2900669ec5dd0b27e075679` (≠ all-0xFF),
  `dd if=/dev/mtd5 bs=4 count=1 | hexdump` = `hsqs`.
- **Boots:** `OpenWrt 25.12.5, r33051` / `uname -r` = `6.12.94`; `/proc/mtd` splits mtd4 kernel + mtd5
  rootfs + mtd6 rootfs_data; dmesg `squashfs: version 4.0`, `1 squashfs-split partitions found`,
  **`VFS: Mounted root (squashfs filesystem) readonly on device 31:5`** (no panic).
- **WiFi:** `rt2x00_set_rf: RF chipset 7620 detected`.
- **Bridge:** `/dev/spidev1.0` present; **`spid /dev/spidev1.0 514 513 /var/run/tessel`** (resolver found
  base=512 at 6.12, passed base+2/base+1) + `usbexecd[1571]` steady at boot; **zero `invalid GPIO`**.

Evidence: `soc-2512-gate-final.log`, `soc-2512-boot-fragment.log`. **This closes the OS uplift: the whole
15.05→25.12 ladder is hardware-validated end to end, and libgpiod was never needed anywhere on it.**

---

## 3. The breakthrough: a USB serial console — root shell on *any* image

The single most important capability unlocked this session.

**What it is:** the Tessel's SAMD21 coprocessor firmware exposes the MT7620's Linux UART console
as a **USB CDC-ACM** interface on the *existing* USB cable. No UART soldering, no WiFi, no `spid`,
no network — it works on a bare restore image, a half-broken uplift, anything that boots a kernel.

**Wiring** (from `t2-firmware`): composite **interface #2** (CDC data), **IN endpoint `0x84`**
(SoC → host, console output), **OUT endpoint `0x04`** (host → SoC, keystrokes). On Windows all
three Tessel interfaces are WinUSB-bound (no `usbser.sys` COM port), so the console is driven via
**node-usb / libusb** directly, not a serial terminal.

**Tools** (in `repos/t2-cli/`):

| Script | Purpose |
|--------|---------|
| `usb-console-probe.js` | One-shot enumerator: confirms IF#2 = CDC data, EP `0x84`/`0x04`. |
| `usb-console-read.js`  | Streams the SoC console (EP `0x84`) to a logfile for N seconds — capture a full boot log. |
| `usb-console-cmd.js`   | Sends a `\r\n` wake + argv commands to EP `0x04`, captures the reply. **A real root shell.** |

**Why it matters:** the 24.10 uplift stalled precisely because bring-up failures were invisible.
With this console, every future hop (19.07, the 21.02 pivot, 24.10) is now diagnosable at the
kernel/userspace level — we can read `logread`, check `/dev/spidev*`, inspect `spid`, watch the
boot sequence, and edit `uci` config, all without a working bridge.

**Operational notes:**
- A **power-cycle re-enumerates USB** and invalidates the libusb handle. To capture a fresh boot:
  power-cycle **first**, wait ~5–8 s for re-enumeration, **then** attach the reader.
- The console shares the USB endpoint with `t2-cli`; heavy console use can degrade the shared data
  endpoint, so run at most one consumer at a time and apply the USB-STALL recipe (below) before a
  clean `t2-cli` op.

---

## 4. Hop 3 — 19.07 non-boot ROOTFS-MOUNT PANIC → RESOLVED + HW-validated (2026-07-16)

19.07 writes correctly but does not boot. A **full USB serial-console boot capture**
(`session .../files/soc-1907-boot-panic.log`) gives the unambiguous root cause — and it is **NOT**
the entropy/urngd stall previously hypothesised. The device never reaches userspace at all; it
**panics at t=0.52 s while mounting the root filesystem**:

```
Kernel command line: console=ttyS0,115200 rootfstype=squashfs,jffs2      <-- no root=
Creating 4 MTD partitions on "spi0.0":
  0x000000-0x030000 : "u-boot"
  0x030000-0x040000 : "u-boot-env"
  0x040000-0x050000 : "factory"
  0x050000-0x2000000 : "firmware"
VFS: Cannot open root device "(null)" or unknown-block(0,0): error -6
Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)
Rebooting in 1 seconds..
```

**What this means:**

- The **kernel is healthy** — u-boot loads the uImage at `0x50000`, decompresses, and runs
  Linux 4.14.275. CS1/SPI is fine (`spi spi0.0` and `spi spi1.0 force spi mode3` both present).
  So this is **not** a flash-offset, restore, CS1, or spid problem.
- The **"firmware" MTD partition (`0x50000–0x2000000`) is never split into kernel+rootfs.** Only
  the 4 static partitions appear — there is **no dynamic `rootfs` mtdblock** and no
  `mtd: … (rootfs) set to be root filesystem` line. With no rootfs block device, the kernel
  cmdline carries no `root=`, and OpenWrt's ramips auto-root has nothing to mount → panic →
  reboot loop (this is exactly the earlier "POWER blinking / WiFi not broadcasting / ERR faint").

**Why 18.06 boots but 19.07 doesn't — ROOT CAUSE CONFIRMED (sub-session commit a2fd3a6).** It is
**not** a missing kernel symbol: `CONFIG_MTD_SPLIT_UIMAGE_FW=y` in *both* 18.06 and 19.07. The
delta is **how the firmware partition is selected for splitting**:

- **≤18.06 (k≤4.14): name-based.** `CONFIG_MTD_SPLIT_FIRMWARE=y` runs the FIRMWARE parsers on any
  partition labelled `"firmware"`; 18.06's `mtdsplit_uimage.c` has no `of_match_table`, so a bare
  `label="firmware"` is enough.
- **≥19.07: DT-driven.** That name-based symbol is gone from `mt7620/config-4.14`, replaced by
  device-tree matching — 19.07's `mtdsplit_uimage.c` gained
  `.of_match_table = { .compatible = "denx,uimage" }`. The firmware partition must now declare
  `compatible = "denx,uimage"` to be split.

Our shared `Tessel.dts` carried the old bare `label="firmware"` (no `compatible`), so on 19.07 no
parser matched → firmware never split → no rootfs mtd → no `root=` → panic. Exactly the captured
evidence (4 raw partitions, no rootfs mtdblock).

**Fix (single-line DTS, all-hop safe):** add `compatible = "denx,uimage";` to the firmware
partition. On ≤18.06 the parser has no `of_match_table` so it's ignored (name-based split still
applies → no regression to validated 17.01/18.06); on ≥19.07 it's exactly what the DT parser
matches. Mirrors upstream 19.07 `WRTNODE.dts`. Committed **a2fd3a6**.

**Fix attempt #1 — HARDWARE-TESTED 2026-07-16: FAILED, and it REGRESSED the layout.** Flashed the
rebuilt image (sha `9AC950…`) via repackaged-restore (write 100 % verified). Device still
reboot-loops (POWER blink, ERR flicker, no `Tessel-Diag` AP). The captured boot log
(`session .../files/soc-1907-denxuimage-regression.log`) shows the partition table got **worse**:

```
3 fixed-partitions partitions found on MTD device spi0.0
Creating 3 MTD partitions on "spi0.0":
  0x000000-0x030000 : "u-boot"
  0x030000-0x040000 : "u-boot-env"
  0x040000-0x050000 : "factory"
VFS: Cannot open root device "(null)" ... Kernel panic ... Rebooting in 1 seconds..
```

The **firmware partition disappeared entirely** (4 → 3 partitions). Putting `compatible = "denx,uimage"`
directly on a **bare partition child** disqualifies it from `fixed-partitions` ofpart enumeration,
so it is never created — no firmware partition, no rootfs, panic. The one-line approach is
incompatible with our current *bare-children* partition layout (partitions declared directly under
the `m25p80`/SPI flash node, not inside a `partitions { … }` container).

**Next levers (handed to the build sub-session):**
- **(A, preferred — ADOPTED):** revert the DTS line and set `CONFIG_MTD_SPLIT_FIRMWARE=y` in the 19.07 kernel
  config — restores **name-based** splitting of the `"firmware"`-labelled partition (the exact
  mechanism that works at 18.06), with **no DTS change** and no layout risk.
- **(B):** wrap the partitions in a `partitions { compatible = "fixed-partitions"; #address-cells=<1>;
  #size-cells=<1>; … }` container, then a nested `compatible = "denx,uimage"` on the firmware **leaf**
  is legal (that container is *why* WRTNODE's declaration works). Requires converting Tessel.dts's
  bare-children partitions to the wrapper form. **Deferred** — not needed while patch 402 (name-based
  split) is present in the k4.14 tree; revisit at whichever later hop removes it.

Device recovered to validated **18.06** after the failed attempt #1 (`t2 list --usb` → `USB␉OpenWrt`).

**Fix attempt #2 (lever A) — HARDWARE-VALIDATED 2026-07-16. ✅** Sub-session commit **b12d0b0**
(supersedes the bad `a2fd3a6`): reverted the firmware partition to **bare** (byte-identical layout to
17.01/18.06) and injected `CONFIG_MTD_SPLIT_FIRMWARE=y` into `target/linux/ramips/mt7620/config-4.14`
from `build.sh apply_overlay()`. **Gotcha:** it is a *kernel* config symbol — a `config.seed`/top-level
`.config` entry is silently dropped by `make defconfig`, so it must land in the target kernel config
fragment. Flashed sha `E1586930…` via repackaged-restore; captured the boot over the USB console and
verified over the console root shell — **the firmware partition now splits**:

```
cat /proc/mtd
  mtd3: 01fb0000 "firmware"
  mtd4: 0018727b "kernel"        <-- NEW (split from firmware)
  mtd5: 01e28d85 "rootfs"        <-- NEW (root mounts here)
  mtd6: 01c20000 "rootfs_data"   <-- NEW (overlay)
```

All gates pass: **OpenWrt 19.07.10** r11427 / uname **4.14.275**; `mount_root`→procd→init→userspace
(no VFS panic); `/dev/spidev1.0` present; `spi spi1.0 force spi mode3`, zero `spi_device register
error`; `spid[1031] Starting` (no error / no crash-loop) + `usbexecd[1065]`; WiFi up (`wlan0`
forwarding); host `t2 list --usb` → **`USB␉OpenWrt`**. Only the expected non-fatal WARN
`/palmbus@10000000/spi@b40/spidev@0: buggy DT: spidev listed directly in DT` (becomes a **hard**
refusal at k5.x → whitelist a non-generic `compatible` at the 21.02 pivot). Boot capture:
`session .../files/soc-1907-fix2.log`.

> **Note on the failed one-line `denx,uimage` attempt:** it not only failed to help — it *regressed*
> the layout (firmware partition vanished, 4→3 partitions) because a bare partition child carrying a
> `compatible` is disqualified from `fixed-partitions` ofpart enumeration. The correct fix keeps the
> partition bare and re-enables name-based split in the kernel config. The stale `denx,uimage` repo
> memories were downvoted/corrected.

> **Note on the earlier "entropy stall" hypothesis:** it is **disproven**. The panic is at t=0.52 s,
> long before any `crng_init`/urngd concern — the boot never gets far enough for entropy to matter.

---

## 5. Recovery playbook (proven this session)

The device was recovered from the 19.07 non-boot **without any brick risk**. Two reliable paths:

### 5a. Factory restore (bare base — always works, but bridge-less)

`t2 restore --usb` over a local HTTP server writes u-boot + factory partition + the factory
SquashFS via the SAMD21 **SAM3/DFU path**, which is **independent of `spid`** (that's why it works
when `t2 update`/`list` can't connect):

```powershell
# serve the factory tarball
cd <dir containing new_build_next.tar.gz>; python -m http.server 8765 --bind 127.0.0.1
# in another shell
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/new_build_next.tar.gz'
node .\repos\t2-cli\bin\tessel-2.js restore --usb
```

⚠️ **The factory tarball is a bare OpenWrt 15.05 base with NO Tessel bridge firmware** (no
`spid`/`usbexecd`/node). After this restore the device **boots fine** (verify via the USB console)
but POWER **blinks forever** (the SAMD21 waits for a `spid` handshake that never comes) and
`t2-cli --usb` can't connect. **This is not a brick** — it's an OS with no bridge.

### 5b. Repackaged restore → flash a *working* image over the spid-free path (recommended)

To land a **bootable, bridge-complete** image without needing `spid` to already work, swap the
target sysupgrade image into the restore tarball as the SquashFS member:

```powershell
# stage: extract factory tarball, replace the squashfs member with the target image
tar -xzf new_build_next.tar.gz -C stage\
Copy-Item tessel-18.06-DIAG.bin `
  stage\openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin -Force
# repack (keep the original u-boot member)
tar -czf new_build_1806.tar.gz `
  -C stage openwrt-ramips-mt7620-Default-u-boot.bin `
           openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin
# serve + restore
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/new_build_1806.tar.gz'
node .\repos\t2-cli\bin\tessel-2.js restore --usb
```

**Why this works:** restore writes the SquashFS to flash `0x50000` — the same firmware-partition
offset a normal sysupgrade targets — so a `-squashfs-sysupgrade.bin` boots identically to a
normal flash, plus it gets a **fresh MediaTek factory/ART partition** (new random radio-cal +
MAC). The tarball entry names must match exactly (`t2-cli` matches on basename):
`openwrt-ramips-mt7620-Default-u-boot.bin` and
`openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin`.

This is a robust flash path that does **not** depend on the on-device bridge — useful whenever a
`t2 update` sysupgrade can't run (bridge down) or when validating an image that might not boot.

### The USB-STALL recipe (host-side, applies to every t2-cli op)

`LIBUSB_TRANSFER_STALL` is a host-side endpoint halt; each stalled/killed op keeps the data
endpoint halted until a physical power-cycle. Cure:

1. Fresh **power-cycle** (unplug ~10 s).
2. **Direct** USB port + cable (no hub).
3. Run **exactly one** clean op; kill any lingering `node …tessel-2.js` / `usb-console-*` process
   first (a lingering process keeps the USB handle claimed and stalls the next open).

---

## 6. What is fixed vs. what is still frozen

**Improved by reaching 18.06** (see the 18.06 risk doc for detail): post-KRACK WiFi
(hostapd/wpad 2018-05-21), modern SSH KEX (dropbear 2017.75 — the
`diffie-hellman-group1-sha1` workaround is no longer needed), a hardened **kernel 4.14** (Dirty
COW fixed), and **signed, still-online opkg feeds** (packages installable again).

**NOT changed by any OpenWrt hop:**
- **On-device Node.js stays 8.11.3** — the soft-float MIPS32 core caps V8, independent of OpenWrt
  version. Application-runtime EOL risk persists at every hop.
- **The `spid`/`usbexecd` bridge is board-specific** and must keep being ported forward:
  - k4.4–k4.14: the **CS1 DTS + pinmux** fix (done, validated).
  - k5.4 (21.02): **✅ done + validated.** Two deltas landed: (a) the CS1 pin-37 patch ported to
    `patches-5.4` (mechanical); (b) a **pinctrl DT-binding** fix — the ramips pinmux driver switched
    to the generic parser (`groups`/`function`, ignoring legacy `ralink,*`), so `state_default` is
    now **dual-spelled** to keep the i2c→gpio mux on every hop (commit `81710cc`). The two breaks we
    braced for did **not** fire at 5.4 and remain deferred: `spidev`'s `compatible = "spidev"` is
    still only a WARN (whitelist deferred to the hop that hard-refuses), and `CONFIG_GPIO_SYSFS=y` is
    still default (libgpiod deferred to the hop that drops sysfs GPIO).
  - k5.10–k5.15 (22.03 / 23.05): **✅ both done + validated.** 22.03 (k5.10) added the **spid-start
    wait-loop** (spidev became a loadable module, racing the START=60 service). 23.05 (k5.15) landed the
    deferred **spidev whitelist** fix — `spidev_of_check()` began hard-refusing a literal
    `compatible="spidev"` with `-EINVAL`, fixed by a version-gated rewrite to `rohm,dh2228fv` so
    `/dev/spidev1.0` reappears; plus a CS1 re-path to `drivers/pinctrl/ralink/pinctrl-mt7620.c`. sysfs
    GPIO survived (still default) — libgpiod stayed unnecessary.
  - k6.6 (24.10) / k6.12 (**25.12** = end target): **libgpiod is NOT needed** (roadmap-corrected 2026-07-16):
    `CONFIG_GPIO_SYSFS` is deprecated-but-present in linux 6.6.73 (stays `=y` in `generic/config-6.6`)
    AND in linux 6.12.87 (`=y` in `generic/config-6.12`, with `# CONFIG_GPIO_CDEV is not set` → sysfs is
    the *only* userspace GPIO iface at 6.12), so spid's sysfs-GPIO path works through the end target. 24.10
    reduces to two mechanical deltas — a `v24.10.*→patches-6.6` harness map and the CS1 patch re-pathed to
    `drivers/pinctrl/mediatek/pinctrl-mt7620.c` (struct `mtmips_pmx_func`) — plus the validated
    carry-forward ledger (rohm,dh2228fv auto-fires via the ≥k5.15 gate; MTD_SPLIT_FIRMWARE injected;
    swconfig still, no DSA at mt7620). **25.12 (k6.12, Mar 2026) is the end target** — the current
    actively-maintained branch; 24.10 EOLs Sep 5 2026 and 22.03/23.05 are already EOL, so only 25.12
    keeps receiving CVE fixes. ⚠️ **25.12 needs its own `patches-6.12` dir** (verified `KERNEL_PATCHVER:=6.12`
    on the `openwrt-25.12` ramips target) — the current `build.sh` `v25.12.*→patches-6.6` map is a latent
    bug to split before building 25.12. **BLOCKER:** 24.10/k6.6 is currently a hard non-boot (squashfs
    rootfs won't mount — see Hop 7 section); that must be solved before 25.12, and it may or may not recur
    at k6.12.

**Retarget note (2026-07-16):** the end target moved from 24.10 → **25.12**. Rationale: as of mid-2026
only 24.10 and 25.12 are maintained, and 24.10's support ends Sep 5 2026, so 25.12 is the only branch
that stays patched. The intermediate hops (22.03, 23.05) are EOL stepping stones walked purely to
isolate each single delta. Note the hard ceilings **no** hop lifts: on-device **Node.js stays 8.11.3**
(soft-float MIPS32 V8 cap — the dominant residual app-runtime risk), the **radio is 2.4 GHz 802.11n**
(WPA3-Personal is the security ceiling, already reached at 21.02), and there is **no perf/RAM gain**
(newer images are bigger → tightening 32 MB flash / 64 MB RAM headroom).

---

## 7. Artifacts & tooling index

| Item | Location |
|------|----------|
| USB console tools | `repos/t2-cli/usb-console-{probe,read,cmd}.js` |
| t2-cli flash fixes | `repos/t2-cli/lib/tessel/update.js` (`T2_FORCE_FLASH` force, version-aware `fixOldUpdateScripts`, `[sysupgrade]` logging) |
| CS1 DTS/pinmux fix | sub-session `aaronpowell-incremental-openwrt-uplift`: `Tessel.dts` + `patches-4.4/999-tessel-mt7620-spi-cs1.patch` (+ k4.14 `spi refclk` trim) |
| Built DIAG images | sub-session `…/build/openwrt-incremental/output/tessel-{18.06,19.07,21.02}-DIAG.bin` |
| Repackaged restore | session `…/files/new_build_{1806,1907,2102}.tar.gz` (DIAG image over the restore path) |
| Full roadmap | sub-session `docs/openwrt-incremental-upgrade.md` + `docs/FLASH-AND-VALIDATE.md` |

> The DIAG images are WiFi-AP builds (`Tessel-Diag` / WPA2 `tesseldiag`, `ssh root@192.168.1.1`)
> used for the SSH validation gate; production images differ but share the same base OpenWrt
> package versions.
