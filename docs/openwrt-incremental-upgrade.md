# Incremental OpenWrt Uplift Roadmap (Tessel 2 / MT7620 / ramips)

> **Purpose.** The full jump straight to OpenWrt 24.10 (kernel 6.6.144) builds and
> flashes but leaves `t2-cli` unable to connect — the `spid`/`usbexecd` coprocessor
> bridge never comes up. That single leap is undebuggable. This document lays out a
> **cautious, incremental** uplift that walks the build up through intermediate OpenWrt
> releases, converting one giant undebuggable jump into a series of small,
> individually-diagnosable deltas.
>
> Companion reading: [`gaps-and-risks.md`](./gaps-and-risks.md) (*OpenWrt upstream
> uplift* + *Hardware validation*), [`how-it-works.md`](./how-it-works.md) §4 (the
> SPI bridge), [`architecture.md`](./architecture.md), and
> [`security-threat-assessment.md`](./security-threat-assessment.md).

---

## 1. Why the bridge breaks — pinned to source

`t2-cli` talks to the board over USB → the SAMD21 → the SPI bus → the on-device
`spid` daemon. `spid` is a 2016-era C daemon that depends on **three** kernel
interfaces which have all since changed or been removed. Each is visible in the code:

### 1.1 SPI bus number `/dev/spidev32766.1`
[`t2-firmware@a22ba2d/soc/spid.sh`](https://github.com/aaronpowell/t2-firmware/blob/master/soc/spid.sh):

```sh
mkdir -p /var/run/tessel
ln -sf /var/run/tessel/1 /var/run/tessel/port_a
ln -sf /var/run/tessel/2 /var/run/tessel/port_b
exec spid /dev/spidev32766.1 2 1 /var/run/tessel
#          ^^^^^^^^^^^^^^^^^^ ^ ^
#          SPI bus.CS         | └ sync GPIO (global sysfs number 1)
#                             └── IRQ  GPIO (global sysfs number 2)
```

`32766` (`0x7FFE`) is the bus number the **aged out-of-tree Ralink SPI master**
assigns. Any OpenWrt built with the modern `ralink,mt7620a-spi` / `spi-mt7621`
driver enumerates the controller as bus **0**, so the node becomes `/dev/spidev0.1`.
The hard-coded path stops resolving and `spid` dies at
`open(argv[1]) … Error opening SPI device`.

### 1.2 Generic `compatible = "spidev"`
[`aaronpowell/openwrt … target/linux/ramips/dts/Tessel.dts`](https://github.com/aaronpowell/openwrt/blob/2018-07-13/target/linux/ramips/dts/Tessel.dts):

```dts
spidev@1 {
    compatible = "spidev";        /* generic — modern spidev rejects this */
    reg = <1 0>;                  /* chip-select 1  → the ".1" in spidev0.1 */
    linux,modalias = "spidev", "spidev";
    spi-max-frequency = <10000000>;
};
```

Mainline `spidev` began **warning** about a bare `compatible = "spidev"` node
(`spidev … buggy DT: spidev listed directly in DT`) around **k4.15**, and by the
**k5.x** era refuses to create `/dev/spidevX.Y` unless the compatible is on its
whitelist (`rohm,dh2228fv`, `lltc,ltc2488`, `ge,achc`, …). No node → no bridge.

### 1.3 sysfs GPIO with global numbers `2` and `1`
[`t2-firmware@a22ba2d/soc/spid.c`](https://github.com/aaronpowell/t2-firmware/blob/master/soc/spid.c)
drives GPIO entirely through `/sys/class/gpio`:

```c
snprintf(path, sizeof(path), "/sys/class/gpio/gpio%s", gpio);   // gpio_export
int fd = open("/sys/class/gpio/export", O_WRONLY);
… "/sys/class/gpio/gpio%s/direction" … "/edge" … "/value"      // gpio_open
GPIO_POLL.events = POLLPRI;   // sysfs edge interrupt on the IRQ pin's value file
```

This depends on `CONFIG_GPIO_SYSFS` **and** a gpiochip base of `0` (so global
numbers `2`/`1` address SoC lines 2/1). Modern kernels **dynamically allocate** the
gpiochip base (so `2`/`1` point at the wrong pins), stop enabling `CONFIG_GPIO_SYSFS`
by default, and ultimately drop the sysfs GPIO interface in favour of the
`/dev/gpiochipN` character device (libgpiod). This is the deepest break — it forces a
real code change, not a config tweak.

---

## 2. Strategy: clean upstream release + thin Tessel overlay per hop

Rather than dragging the heavily-patched 2014 fork
(`aaronpowell/openwrt @ 2018-07-13`, a Barrier-Breaker-era snapshot) forward through a
decade of merge conflicts, **each hop starts from a clean upstream OpenWrt release**
(which already supports the mt7620 target — the Tessel board is essentially a
[WRTnode](https://openwrt.org/toh/wrtnode/wrtnode) variant, as the DTS's
`compatible = "wrtnode"` shows) and re-applies a **thin Tessel overlay**:

- the board **DTS / profile** (a WRTnode-style mt7620n board plus the `spidev` node),
- the **`tessel-tools`** package (builds `spid` + `usbexecd` from `t2-firmware/soc/`),
- a **minimal config** (the coprocessor bridge, `uci`, base system; Node can be added
  once the bridge is proven).

Because the overlay is small, each hop makes it obvious **which** of the three
break-vectors in §1 has just activated — that is the whole point of going
incrementally.

---

## 3. The hop roadmap

| Hop | Release | Kernel | What newly activates | Bridge | Effort |
|----:|---------|:------:|----------------------|:------:|--------|
| 0 | 15.05 "Chaos Calmer" (baseline) | 3.18 | — all three legacy paths work | ✅ | — |
| 1 | 17.01 "Reboot" | 4.4 | **Coprocessor CS1 SPI device fails to register** (factory `spidev@1`/CS1-on-`spi@b00` idiom invalid on the in-tree single-CS driver) + SPI bus renumber | ✅ **VALIDATED** *(DTS → `&spi1` + pin-37 `spi_cs1` pinmux patch; see §11)* | **real (bounded) DTS/pinmux fix** — not purely mechanical |
| 2 | 18.06 | 4.14 | build-system / feed deltas; spidev **"buggy DT" warning** first appears (k4.14, node still created); **CS1 fix ported to k4.14** (see §12) | ✅ **VALIDATED** *(force-flash; §12.4)* | mechanical + trivial 1-line pinmux port |
| 3 | 19.07 | 4.14 | same kernel as 18.06 → spidev warning persists (node still created); **same k4.14 CS1 patch drops in unchanged** (see §13); **NEW break: firmware mtdsplit config drop** → re-enable `CONFIG_MTD_SPLIT_FIRMWARE=y` (see §13.2) | ✅ **HARDWARE-VALIDATED** (`b12d0b0`) | mechanical + 1 kernel-config fix |
| 4 | **21.02** | **5.4** | spidev **refuses** generic compat → **DTS change**; `CONFIG_GPIO_SYSFS` no longer default + **gpiochip base renumber** → begin **libgpiod port**; `urngd` introduced | ⚠️ | **engineering — PIVOT** |
| 5 | 22.03 | 5.10 | firewall4/nftables default; musl/toolchain bump; ramips **DSA** conversions begin | ⚠️ | medium |
| 6 | 23.05 | 5.15 | stricter spidev; libgpiod effectively mandatory; switch DSA; cmake/toolchain bumps (the `urngd` CRT workaround) | ⚠️ | medium |
| 7 | 24.10 | 6.6 | **sysfs GPIO gone → libgpiod mandatory**; spidev whitelist enforced; bus 0 | ⛔ *(today's failure)* | validates the port |

> Kernel↔release mapping per the [OpenWrt version table](https://openwrt.org/releases/table);
> 24.10 = kernel 6.6.144 confirmed empirically by the parent session.

### 3.1 Per-hop deviations to hunt for (mapped to the release that introduces them)

| Deviation | First bites at | Notes |
|-----------|:--------------:|-------|
| **Coprocessor CS1 SPI-device registration** | **17.01 (k4.4)** | **True first hard break** (found on hardware, §11). Factory idiom `spidev@1`/CS1 under single `spi@b00` is rejected by the in-tree single-CS `spi-rt2880` driver. Fix: move coprocessor to the upstream **two-controller** `&spi1` (`spi@b40`, bus 1) as `spidev@0` (→ `/dev/spidev1.0`) + a **pin-37-only `spi_cs1`** kernel pinmux patch (which also frees pin 38 for the user2/POWER LED). Only visible at kernel runtime. |
| **SPI bus number** (`/dev/spidev32766.1`) | 17.01 (k4.4) | Subsumed by the CS1 fix above: `spid-start` now autodetects `/dev/spidev*` (coprocessor enumerates as `/dev/spidev1.0`). Optionally pinned via the upstream DT `aliases { spi1 = &spi1; }`. |
| **spidev DT compatible** | warns **18.06** (k4.14), hard 21.02 (k5.4) | `spidev_probe()` at k4.14 does `WARN(of_device_is_compatible(node,"spidev"), "buggy DT…")` — **warn-only, node still created** (verified in source, see §8). Both 18.06 and 19.07 are k4.14. Fix at the pivot: change DTS `compatible` to a whitelisted string (e.g. `rohm,dh2228fv`) or patch spidev's `of_device_id` table. |
| **sysfs GPIO base / availability** | 21.02 (k5.4) → gone by 24.10 (k6.6) | gpiochip base dynamic → global `2`/`1` wrong; `CONFIG_GPIO_SYSFS` not default; interface removed later. Port `spid.c` to **libgpiod / `/dev/gpiochipN`**, addressing lines by `(chip, offset)`. |
| **Device tree churn** | ongoing | mt7620 DTS moved to `dtsi` includes + `&label` overlays; re-express the Tessel board over each release's WRTnode/mt7620n base. |
| **Switch: swconfig → DSA** | 22.03 / 23.05 | ramips DSA conversion is staged; affects `network` config + `board.d`. Off the USB/`spid` critical path but needed for LAN/SSH + hw smoke tests. |
| **Firewall: iptables → nftables/fw4** | 22.03 (k5.10) | Default config only; regenerate `firewall` config. |
| **Build system** | 21.02+ | `urngd` (parent's CMake CRT-probe workaround), `rules.mk`/staging visibility, musl/toolchain bumps, package `Makefile` format. |
| **tessel-tools / tessel packages** | per hop | Watch for patches that stop applying and `config.mk` `PACKAGES` entries renamed/dropped upstream (e.g. `python` → `python3`, `usb-modeswitch`, `mjpg-streamer`). |

---

## 4. Earliest release where the bridge breaks (deliverable 2)

There is **no single clean break**. The bridge unravels in **four stages** (the first
was only discovered once we got a shell on real 17.01 hardware — see §11):

0. **First HARD break — coprocessor SPI device fails to register** at **17.01 (k4.4)**.
   The factory tree put the coprocessor at `spidev@1` (chip-select **1**) under the
   single `spi@b00` controller, relying on an out-of-tree Ralink SPI master that gave
   that controller two chip-selects. The in-tree `spi-rt2880` driver gives `spi@b00`
   only `num_chipselect = 1`, so `spi_add_device` rejects `chip_select = 1` →
   `/dev/spidev0.1` is never created → spid crash-loops. **Needs a real (bounded)
   DTS + kernel-pinmux fix** (§11). *Only visible at kernel runtime — pure build
   analysis could not catch it.*
1. **Cosmetic / mechanical:** the **SPI bus number** — the hard-coded
   `/dev/spidev32766.1` no longer resolves. Handled by making `spid-start` autodetect
   whatever `/dev/spidev*` node exists (now `/dev/spidev1.0`, see §11).
2. **First break needing a DTS change:** the **spidev whitelist** — the `spidev.c`
   "buggy DT: spidev listed directly in DT" `WARN()` **already fires at 17.01 (k4.4)**
   (confirmed on hardware, §11.6) but is **warn-but-continue** — the node is still created
   and works. It stays non-fatal through **19.07 (k4.14)** and becomes a **hard refusal by
   21.02 (k5.4)** (the WARN turns into "no node created" unless a whitelisted `compatible`,
   e.g. `rohm,dh2228fv`, is used). Requires a whitelisted `compatible` in the DTS from 21.02.
3. **Deepest break — forces new code (the real cause of the 24.10 failure):**
   **sysfs-GPIO → libgpiod**. Begins at **21.02** (base renumber + not default), and
   is **unavoidable by 24.10 (k6.6)** once sysfs GPIO is gone.

> **⇒ Model correction:** the earlier claim that *"everything at/below 19.07 is purely
> mechanical"* is **partially falsified**. Stage 0 (CS1 SPI-device registration) is a
> genuine — though bounded — DTS/driver fix that lands right at **hop 1 (17.01)**. It is
> the true **first hard break** and the current proof-of-method. GPIO/libgpiod is still a
> separate, later concern: sysfs GPIO with a base-0 gpiochip is present and valid at k4.4,
> so that vector is **not** yet active at 17.01. The **21.02 (k5.4)** pivot (DTS
> spidev-compatible swap **and** libgpiod GPIO port) remains the deepest engineering step;
> everything between the 17.01 CS1 fix and 21.02 is mechanical.

---

## 5. Go / no-go validation gate (every hop)

Run in order; do not advance to the next hop until all pass. Any bad flash is
recoverable, so experimentation is safe.

1. **Build** — clean upstream release + Tessel overlay produces
   `…/openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin`.
2. **Flash** *(human, OS-only)* —
   `node repos/t2-cli/bin/tessel-2.js update --usb --openwrt-path <bin>`
   (firmware handoff stays out of scope; hardware is at the human's desk).
   - **⚠ Cross-version sysupgrade metadata gate (17.01+ → any newer hop).** OpenWrt
     `sysupgrade` refuses to write unless the running system's `board_name`
     (`/tmp/sysinfo/board_name`) matches the image's appended
     `supported_devices` metadata. The Tessel target never set a `board.d`
     board name, so **17.01 self-reports `board_name = "generic"`** while every
     built image advertises `supported_devices:["tessel"]` → **mismatch → sysupgrade
     exits WITHOUT writing** ("Finished" prints but the device stays on the old
     release). This check does **not** exist in 15.05, which is why factory(15.05)→17.01
     flashed clean but 17.01→18.06 refuses. **Every hop from 17.01 upward needs a force
     or a board_name fix** (see §12.3). Force path: set `T2_FORCE_FLASH=1` (env-gated
     `sysupgrade -F`, added to t2-cli `lib/tessel/update.js`, same convention as
     `T2_RESTORE_URL`).
3. **`spid` up** — after boot: `/var/run/tessel/{usb,1,2}` sockets exist and
   `logread | grep spid` shows `spid: Starting` without a `fatal(...)` line
   (SPI-open / GPIO-export failures land here).
4. **t2-cli connects** —
   `node repos/t2-cli/bin/tessel-2.js list --usb` / `version --usb` returns promptly
   (redirect streaming output to a file; kill any lingering `node …tessel-2.js`
   holding the USB handle first).
5. **Hardware smoke test** — `t2 run` a blinky / one in-scope module script.

**Recovery (any hop):** serve the factory tarball locally and restore —
`python -m http.server 8765` + `T2_RESTORE_URL=http://127.0.0.1:8765/new_build_next.tar.gz`,
then `node repos/t2-cli/bin/tessel-2.js restore --usb`. A physical replug is sometimes
needed after heavy flash/restore cycles.

---

## 6. Fixed constraints (out of scope for the uplift)

- **On-device Node stays at 8.11.3** — the MIPS32 soft-float ceiling; the OpenWrt
  version does not change this. User scripts stay within the Node 8 surface;
  host-side tooling can be any modern Node.
- **Firmware bootloader handoff** during `t2 update` is unreliable
  (`No device found in bootloader mode`) and must stay **human-supervised**; do all
  OS work with `--openwrt-path` so firmware is skipped.
- **Hardware flashing requires the human** — build/analysis is autonomous; flash/boot/
  replug tests are prepared as exact commands and handed off.

---

## 7. Recommended execution order

1. **17.01 (k4.4)** — validate the *method*: clean upstream + thin overlay + the
   one-line bus-number fix should yield a **fully working bridge with zero C changes**,
   proving the harness and the mechanical/engineering boundary.
2. **18.06 → 19.07** — confirm they stay mechanical; capture the first spidev warning.
3. **21.02 (k5.4)** — do the real work: DTS `compatible` swap **and** port `spid.c`'s
   GPIO to libgpiod. This is the milestone that unlocks everything above it.
4. **22.03 → 24.10** — mechanical bring-up plus the swconfig→DSA and
   iptables→nftables config migrations; 24.10 becomes the validation that the 21.02
   port holds on kernel 6.6.

## 8. Hop 1 (17.01) build result — actually built this session

The clean-upstream + thin-overlay method was validated end to end: a complete
**OpenWrt/LEDE 17.01.7 Tessel 2 sysupgrade image builds successfully** in the Docker
harness under `build/openwrt-incremental/`. Artifact:
`output/lede-ramips-mt7620-tessel-squashfs-sysupgrade.bin` (~3.3 MB), with the
`tessel-tools` bridge (`spid` + `usbexecd`) compiled in. Flash/boot validation is
human-supervised — see `build/openwrt-incremental/FLASH-AND-VALIDATE.md`.

Getting there surfaced exactly the small, individually-diagnosable deltas the
incremental approach is designed to expose. Five were hit and fixed, in build order:

1. **Dead 2017 infra (feeds).** 17.01's `feeds.conf.default` points at
   `git.lede-project.org` (expired TLS). Fix: generate a `feeds.conf` against the
   GitHub mirrors (`openwrt/{packages,luci,routing,telephony}`, branch `lede-17.01`)
   and treat feed failures as non-fatal (the minimal bridge image is core-tree only).
2. **Dead 2017 infra (source tarballs).** `gcc-5.4.0` et al. 404 from the original
   mirrors. Fix: a `scripts/localmirrors` pointing at the live `sources.openwrt.org`
   archive, plus `DOWNLOAD_MIRROR`.
3. **Host tools refuse to build as root.** `tar-1.29`'s configure aborts under the
   root container user. Fix: `FORCE_UNSAFE_CONFIGURE=1`.
4. **Device-profile config symbol renamed across releases.** 17.01 selects the board
   with `CONFIG_TARGET_ramips_mt7620_DEVICE_tessel`; the `CONFIG_TARGET_DEVICE_…`
   infix form is a 19.07+ convention. The seed now lists both (defconfig drops the
   inapplicable one). *Track this rename at the 18.06→19.07 hop.*
5. **`usbexecd.c` vs musl `<stdio.h>` — a genuine source-portability bug.** The daemon
   names struct members and function parameters `stdin`/`stdout`/`stderr`, which are
   object-like macros in musl (`#define stdin (stdin)`), so `p->stdin` preprocesses to
   `p->(stdin)`. Fixed non-invasively with a force-included
   `musl-stdio-fixup.h` (`#include <stdio.h>` then `#undef` the three) — no upstream
   source edit. This is toolchain-driven (musl), **not** a kernel-interface break, so
   it does not move the 21.02 bridge-porting pivot; but it is a required C fix, so the
   §7 note that 17.01 needs "zero C changes" is corrected to "one trivial,
   mechanical C shim (no logic change)".
6. **DTS duplicate label.** Our `Tessel.dts` labelled a pinctrl group `spi_cs1`, which
   collides with the same label already defined in the mt7620 SoC `.dtsi`
   (`/pinctrl/spi1`). Fix: drop the redundant label, keep the SPI-CS1 pin-mux node.

**Net:** the 17.01 base (toolchain, kernel 4.4.182, all core packages) and the Tessel
bridge daemons compile cleanly. Remaining gate is on-hardware: flash → confirm
`/dev/spidev*` + `/var/run/tessel/*` sockets → `t2-cli` connects. Per the §1.1
analysis, the only *runtime* delta expected at 17.01 is the SPI bus renumber
(`32766`→`0`), already handled by the autodetecting `spid-start`.

## 9. Hops 2–3 (18.06 / 19.07) build results + spidev source corroboration

Both built with the **same overlay and zero new fixes** — the 17.01 deltas (mirrors,
`FORCE_UNSAFE_CONFIGURE`, dual device-symbol seed, `musl-stdio-fixup.h`, DTS label)
were necessary and sufficient. This confirms the "everything ≤19.07 is mechanical"
claim at build time.

| Hop | Tag | Kernel (actual) | Artifact | tessel-tools |
|----:|-----|:---------------:|----------|:------------:|
| 2 | `v18.06.9` | **4.14.206** | `openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin` (3.6 MB) | ✅ `tessel-tools_0.1-1_mipsel_24kc.ipk` |
| 3 | `v19.07.10` | **4.14.275** | `openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin` (3.8 MB) | ✅ `tessel-tools_0.1-1_mipsel_24kc.ipk` |

**Roadmap correction:** 18.06 ramips runs **kernel 4.14.206**, not 4.9 — so 18.06 and
19.07 share the *same* kernel. The spidev "buggy DT" warning therefore first appears at
**18.06**, not 19.07 (tables in §3 / §3.1 updated).

**spidev source evidence (corroborates the break-stage model without hardware).** In the
k4.14 tree pulled by the 18.06 build,
`build_dir/.../linux-4.14.206/drivers/spi/spidev.c` → `spidev_probe()`:

```c
/*
 * spidev should never be referenced in DT without a specific
 * compatible string, it is a Linux implementation thing …
 */
WARN(spi->dev.of_node &&
     of_device_is_compatible(spi->dev.of_node, "spidev"),
     "%pOF: buggy DT: spidev listed directly in DT\n", spi->dev.of_node);
/* …falls through and still allocates minor + registers the char device… */
```

This is a **non-fatal `WARN()`**: the probe continues past it and still creates
`/dev/spidevX.Y`. So on 18.06/19.07 the generic `compatible = "spidev"` node keeps
working (dmesg will carry the warning — the cheap runtime tell to look for on hardware).
The **hard** refusal (probe returns early unless the compatible is whitelisted) lands in
the k5.x era → **21.02**, exactly the pivot. Net: source confirms warns-but-works ≤19.07,
hard-break at the pivot — the break-stage model holds at build-source level.

**19.07 verified identically (kernel 4.14.275).** The same `WARN(... "buggy DT: spidev
listed directly in DT")` sits at `linux-4.14.275/drivers/spi/spidev.c:736`, and the
probe still falls through to `device_create(..., "spidev%d.%d", spi->master->bus_num,
spi->chip_select)` — node created, no early return, no whitelist gate. 19.07 built with
**zero new fixes** (17.01 deltas necessary and sufficient across all three hops), so the
"mechanical ≤19.07" model is now confirmed at build time for 17.01, 18.06, **and 19.07**.

**Parked at 19.07 per parent instruction:** the 21.02 pivot (DTS whitelisted-compatible
swap + `spid.c` libgpiod port) is **not** started; it waits until 17.01 is confirmed on
real hardware (bridge up, `t2-cli` connects).

## 10. Hop 1 (17.01) hardware verdict + Wi-Fi-AP diagnostic image

**Status: built OK; hardware boot FAILED (black box); pending Wi-Fi-AP diagnostic image.**

The clean 17.01 image flashed cleanly over USB (`update --usb --openwrt-path …`:
"Transfer complete", "Finished updating…", firmware skipped) but boots to the **same
black box as 24.10**: USB re-enumerates (SAMD21 up, all interfaces OK) yet **POWER blinks
forever** and t2-cli never connects (`list`/`version --usb` hang at "Looking for your
Tessel…"). The board was recovered to factory via `restore --usb` (reliable).

This does **not** cleanly falsify the "≤19.07 mechanical" *build* model — that model is
about compilation, and it still holds (three hops built). The boot failure is a *runtime*
result with **zero device visibility**: blinking-POWER + enumerated-USB + no-bridge is
ambiguous between (a) kernel/init hangs early (nothing to do with spid) and (b) Linux
boots but spid fails. We cannot tell which without a shell on the device.

**Candidate root causes (cheapest first):**
1. **Cross-distro config preservation** — the default flash preserves CC-15.05
   `/etc/config` onto LEDE 17.01 ("Configuration is saved during update"). Cross-version
   carry-over is a classic boot-breaker and is purely a *flashing-procedure* issue, not a
   spid/DTS incompatibility. **Top suspect.**
2. **Thin-overlay incompleteness** — image missing boot-critical Tessel bits. *Checked:
   the 17.01 image manifest already contains the SoC Wi-Fi driver (`kmod-rt2800-soc`),
   `wpad-mini`, `hostapd-common`, `dropbear`, `dnsmasq`, `netifd` — so it is not missing
   networking/SSH/Wi-Fi. Lower probability than first thought.*
3. **Genuine earlier runtime break** (spid SPI-bus autodetect / DTS) — least likely per
   the build-source analysis, not excluded.

**Decision: still DO NOT start the 21.02 pivot** (that gate — 17.01 up on hardware — is
unmet). Instead, two software-only moves converted the black box into something
diagnosable:

### 10.1 Clean-config flash path (addresses suspect #1) — no rebuild
t2-cli already supports it: `t2 update` has a stock **`-n`** flag
(`bin/tessel-2.js` → `lib/tessel/update.js`: `opts.n` → `commands.sysupgradeNoSaveConfig`
→ on-device **`sysupgrade -n`**), which skips config carry-over. So the config-reset test
is just `update --usb --openwrt-path <img> -n` — zero image changes. If a clean `-n` flash
boots (POWER steady) where the config-save flash blinked, suspect #1 is confirmed.

### 10.2 Wi-Fi-AP diagnostic image (gives device visibility without serial)
A `TESSEL_DIAG=1` build bakes a first-boot `/etc/uci-defaults/99-tessel-diag-wifi` script
(via OpenWrt's `files/` mechanism) that raises a **WPA2 AP** (`Tessel-Diag` /
`tesseldiag`) on the MT7620 SoC radio and sets a known root password. **If Linux boots at
all**, a laptop joins the AP and SSHes to `root@192.168.1.1` to read `logread`/`dmesg` —
bypassing the dead spid bridge entirely and telling us (i) whether Linux booted and (ii)
exactly why spid didn't come up. Verified: the radio driver + `wpad`/`dropbear`/`dnsmasq`
are already in the image; boot order (`kmodloader` → `uci_apply_defaults`) means the phy
exists when the script runs, and `detect_mac80211` won't clobber the config.

- **Build:** `TESSEL_DIAG=1 OPENWRT_TAG=v17.01.7 docker compose run --rm build` →
  `output/lede-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin` (built OK, exit 0; diag
  script confirmed baked into the staged rootfs). The gate keeps the normal validation
  image clean (`rm -rf $SRC/files` unless `TESSEL_DIAG=1`).
- **Flash it with `-n`** so the baked AP defaults take effect *and* the config-reset test
  runs in the same shot.
- Exact flash / join-AP / pull-logs commands + outcome-interpretation table:
  `build/openwrt-incremental/DIAGNOSE-17.01-WIFI-AP.md`.

### 10.3 UART serial console — gold-standard fallback
If even the Wi-Fi-AP boot yields nothing, the hang is very early and only a serial
console will show it. The kernel is already configured for it (DTS
`bootargs = "console=ttyS0,115200"`, MT7620 UART0). 3.3 V USB-TTL on UART0 TX/RX/GND,
115200 8N1. Details in the diagnostic doc §4.

---

## 11. Hop 1 (17.01) — the CS1 SPI-registration break, root cause + fix

**Status: ✅ FIXED and FULLY HARDWARE-VALIDATED. All success-gate items pass on real
hardware: `/dev/spidev1.0` present, `spid` up and stable, coprocessor CS registers, POWER
LED steady, and `t2-cli list --usb` → `USB␉LEDE` (end-to-end host→coprocessor→spid→MT7620).
Hop 1 is proven; the incremental method works.**

### 11.1 What the Wi-Fi-AP shell proved
The `-n` clean-config DIAG image brought up the `Tessel-Diag` AP and a working SSH shell.
That **rules out** the two cheap suspects from §10: config carry-over (this was a clean
`-n` flash and it still blinked) and overlay incompleteness (AP + SSH + dropbear + dnsmasq
all run). **Linux boots. The blinking POWER LED is a red herring** — it only means the
Tessel LED/bridge setup didn't finish, not that the kernel failed to boot. (The earlier
24.10 "black box" almost certainly had Linux up with spid failing too.)

### 11.2 The smoking gun (LEDE 17.01, kernel 4.4.182, over SSH)
```
# ls -l /dev/spidev*     → No such file or directory
# logread | grep -i spi
  spi_master spi0: spi_device register error /palmbus@10000000/spi@b00/spidev@1
  spi_master spi0: Failed to create SPI device for /palmbus@10000000/spi@b00/spidev@1
  spid[...]: Error opening SPI device /dev/spidev0.1: No such file or directory  (crash loop)
  procd: Instance spid::instance1 is in a crash loop 6 crashes → gave up
# dmesg | grep -i spi
  spi spi0.0: force spi mode3               ← CS0 (flash) registers fine
  spi_master spi0: spi_device register error /palmbus@10000000/spi@b00/spidev@1   ← CS1 FAILS
# leds-gpio: probe of gpio-leds failed with error -2 ; rt2880-pinmux: pin 38 is not set to gpio mux
```
CS0 (the SPI-NOR flash) registers; **CS1 (`spidev@1`, `reg=<1>`) fails at
`spi_add_device`** → `/dev/spidev0.1` never exists → spid crash-loops → no bridge →
t2-cli can't connect.

### 11.3 Root cause (pinned to source)
- **The Tessel idiom is one-controller-two-CS.** The factory 3.18 DTS placed the
  coprocessor at `spidev@1` (chip-select **1**) under `spi@b00`, and the factory kernel
  carried out-of-tree patches (`0050`/`0051`/`999-mt7620-spi-cs1` in `tessel/openwrt`)
  that made that single controller expose **two** chip-selects (per-CS register banks,
  `master->num_chipselect = ops->num_cs`).
- **Upstream OpenWrt/LEDE re-expressed the MT7620 dual-CS as two *separate* controllers**
  sharing the SPI arbiter: `spi0: spi@b00` (bus 0, flash on CS0) and
  `spi1: spi@b40` (bus 1, the coprocessor). The in-tree `spi-rt2880` driver already drives
  bus 1 (`bus_num==1 → SPI1_POR | ARB_EN`; `get_arbiter_offset()` maps both to the shared
  arbiter at `0xbF0`). But `spi@b00` there is a **single-CS** controller
  (`num_chipselect = 1`), so the factory's `chip_select = 1` node is invalid → the CS1
  registration error above.
- **The missing pinmux piece.** Upstream `spi1: spi@b40` references pinctrl group
  **`spi_cs1`**, but stock `arch/mips/ralink/mt7620.c` never defines it — it only has
  `"spi refclk"` spanning **pins 37, 38, 39**. So `&spi1` could not be muxed, *and* pin 38
  (Tessel's user2 blue LED, `gpio1 14`) explains the cosmetic `leds-gpio error -2` /
  `pin 38 is not set to gpio mux` warnings.

### 11.4 The fix (built this session — the upstream two-controller model)
1. **DTS** (`overlay/dts/Tessel.dts`): move the coprocessor off `&spi0` and onto
   `&spi1 { status = "okay"; spidev@0 { compatible = "spidev"; reg = <0>; … }; }`.
   `aliases { spi1 = &spi1; }` (upstream) fixes the bus number, so the coprocessor now
   enumerates as **`/dev/spidev1.0`**. `&spi0` is left flash-only. The stale
   `state_default` `"spi cs1"` mux entry (which referenced a non-existent group) was
   removed — `&spi1`'s own `pinctrl-0 = <&spi_cs1>` now handles muxing.
2. **Kernel pinmux patch**
   (`overlay/patches/ramips/patches-4.4/999-tessel-mt7620-spi-cs1.patch`): define the
   `spi_cs1` group as **pin 37 only** — `FUNC("spi_cs1", 0, 37, 1)` /
   `GRP("spi_cs1", refclk_grp, 1, MT7620_GPIO_MODE_SPI_REF_CLK)`. Keeps the same hardware
   mode bit (`SPI_REF_CLK`, which makes pin 37 the 2nd SPI chip-select on MT7620) but
   trims the group from 3 pins to 1, so **pins 38/39 stay free** — this fixes CS1 **and**
   the POWER/user2 LED in one shot. Mirrors the factory `999-mt7620-spi-cs1.patch` intent,
   re-expressed for the in-tree two-controller layout.
3. **`spid-start`**: pick the first `/dev/spidev*` that exists (fallback `/dev/spidev1.0`)
   instead of hard-coding a bus/CS — robust across renumbering. The flash uses the
   `spi-nor` driver, which creates **no** spidev node, so the coprocessor is the only one.
4. **Build harness**: `build.sh` `apply_overlay()` now copies overlay kernel patches into
   `target/linux/ramips/patches-<kver>/` via a `kernel_patch_dir()` map (17.01→`patches-4.4`),
   so the 4.4-context patch never leaks into the parked 18.06/19.07 (k4.14) trees.

**Build-level verification (this session):** rebuilt `v17.01.7` DIAG after
`make target/linux/clean`; the 999 patch applied with no `.rej`; the built kernel's
`mt7620.c` shows `spi_cs1` at pin 37; the compiled DTB shows `spi@b40 status="okay"` with
`spidev@0 compatible="spidev" reg=<0>` and the `spi_cs1` pinmux group resolving. Artifact:
`output/lede-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin` (3.3 MB).

### 11.5 Hardware success gate (after flashing the CS1-fixed DIAG image, over SSH)
- `ls /dev/spidev*` → a node exists (expect **`/dev/spidev1.0`**).
- `logread | grep -i spid` → spid running, **no** "Error opening SPI device", no crash loop.
- `dmesg | grep -i spi` → **no** "spi_device register error"; the coprocessor CS registers.
- POWER LED goes **steady** (pin-38 freed) — bonus confirmation of the pinmux trim.
- Then `node repos/t2-cli/bin/tessel-2.js list` / `version --usb` → **connects**.

If all pass, hop 1 (17.01) is validated on hardware and the incremental method is proven —
only then does the **21.02 (k5.4)** pivot (spidev whitelist + libgpiod) begin.

### 11.6 Hardware validation RESULT — ALL gate items PASSED ✅
The CS1-fixed DIAG image was flashed with `-n` and validated on real hardware, first over
the `Tessel-Diag` Wi-Fi/SSH shell (bridge-level gate) and then via t2-cli over USB
(end-to-end gate). **Every success-gate item passes.**

```
# ls -l /dev/spidev*
crw-------  1 root root  153, 0  /dev/spidev1.0        ← node EXISTS (coprocessor on &spi1/CS0)
# logread | grep -i spid
spid[712]: Starting                                    ← bridge up; NO "Error opening SPI device"; NO crash loop
# dmesg | grep -i spi
spi spi1.0: force spi mode3                            ← CS registers cleanly
#   (the old fatal "spi_device register error /…/spidev@1" is GONE)

host> node repos/t2-cli/bin/tessel-2.js list --usb
USB	LEDE                                               ← t2-cli connected END-TO-END
```

- **`/dev/spidev1.0` present + `spid` up and stable + `t2-cli list --usb` → `USB␉LEDE`**
  → the DTS move to `&spi1` and the pin-37-only `spi_cs1` pinmux patch are **correct and
  sufficient at 17.01/k4.4**. The bridge works end-to-end
  (host → coprocessor → spid over SPI → MT7620 → `uci get hostname` = `LEDE`), not just at
  build time.
- **Residual, non-fatal:** `spidev spi1.0: buggy DT: spidev listed directly in DT` +
  a `spidev.c:720` `WARN()` stack. This is a **warn-but-continue** — the node is still
  created (proven: `/dev/spidev1.0` exists and `spid` opened it). This is exactly the
  **k4.x "warns-but-works" stage** of the spidev-whitelist deviation (§1.2 / §4 stage 2);
  the **hard refusal** only arrives at k5.x, i.e. the **21.02** pivot. **Nothing to fix at
  17.01.**
- **LED/pin-38:** the pinmux trim frees pin 38 (user2 LED); POWER LED is **visually
  confirmed steady** on the bench — corroborating the pinmux patch took effect.

**⇒ Hop 1 (LEDE 17.01) is FULLY VALIDATED on hardware. The incremental clean-upstream +
thin-overlay method is proven, and the CS1 SPI-registration fix is the first real (bounded)
Tessel-integration port. The 21.02 (k5.4) pivot is now unblocked *in principle*; whether to
hardware-validate 18.06/19.07 first (both built, predicted mechanical) or go straight to
21.02 is a planning decision (see §7 / execution order).**

> **Host-side USB note (not an image issue):** the flash/connect path fought severe
> `LIBUSB_TRANSFER_STALL` this session. Reliable recipe: **fresh device power-cycle +
> direct USB port/cable, then exactly one clean t2-cli op** — each stalled/killed op halts
> the data endpoint until the next power-cycle. Captured in
> `build/openwrt-incremental/FLASH-AND-VALIDATE.md` so future hops don't repeat the thrash.

## 12. Hop 2 (18.06) — CS1 fix ported to kernel 4.14, DIAG image built (hardware-pending)

Per the parent's door-(a) decision, hop 2 (18.06) is being hardware-validated before
hop 3. The §9 build of 18.06 predated the CS1 fix, so 18.06 was **rebuilt** with the
CS1 fix (the same `&spi1`/`spidev@0` DTS + a **kernel-4.14** pinmux patch) plus
`TESSEL_DIAG=1` (Wi-Fi-AP `Tessel-Diag`) for the SSH gate.

### 12.1 The 4.14 patch is *simpler* than the 4.4 one — the .dtsi group name differs
The pinmux lever is per-kernel because the two releases' stock `mt7620n.dtsi` label the
`&spi1` pin group **differently**:

| Release | Kernel | `spi_cs1` node's `ralink,group` | Patch strategy |
|--------:|:------:|:-------------------------------:|----------------|
| 17.01 | 4.4 | `"spi_cs1"` (name absent from stock mt7620.c) | **rename** mt7620.c's `"spi refclk"` → `"spi_cs1"` **and** trim to pin 37 |
| 18.06 / 19.07 | 4.14 | `"spi refclk"` (the **stock** group name) | **keep** the name `"spi refclk"`, only **trim** its FUNC from 3 pins → pin 37 |

So `patches-4.14/999-tessel-mt7620-spi-cs1.patch` is a **single-line** change:
`FUNC("spi refclk", 0, 37, 3)` → `FUNC("spi refclk", 0, 37, 1)`. Keeping the group
**name** unchanged preserves the stock `.dtsi`'s `<&spi_cs1>` → `"spi refclk"` reference,
while the pin-count trim (a) makes pin 37 the 2nd SPI chip-select via the retained
`MT7620_GPIO_MODE_SPI_REF_CLK` mode bit and (b) frees pins 38/39 (pin 38 = user2/POWER
LED), same net effect as the 17.01 fix. The overlay `Tessel.dts` is unchanged
(release-agnostic: `&spi1 { status="okay"; spidev@0 {…}; }`).

### 12.2 Build-source verification (18.06, kernel 4.14.206) — PASS
- Patch applies **clean** (no `.rej`, no fuzz) into `patches-4.14/`.
- Patched `mt7620.c`: `FUNC("spi refclk", 0, 37, 1)` with `GRP("spi refclk", refclk_grp,
  1, MT7620_GPIO_MODE_SPI_REF_CLK)` (name unchanged — matches the .dtsi).
- Compiled `tessel-kernel.bin.dtb`: `spi@b40` `status="okay"`, child `spidev@0
  compatible="spidev" reg=<0x0>`, alias `spi1 → /palmbus@10000000/spi@b40`, and
  `&spi1`'s `pinctrl-0` phandle resolves to the `spi1` pingroup with
  `ralink,group = "spi refclk"` (i.e. the trimmed, pin-37-only group).
- `world` build **exit 0**. DIAG artifact:
  `build/openwrt-incremental/output/tessel-18.06-DIAG.bin` (copy of
  `openwrt-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin`, 3.6 MB).

This mirrors the hardware-validated 17.01 chain exactly, so `/dev/spidev1.0` and a steady
POWER LED are the expected runtime result. **Status: HARDWARE-VALIDATED (see §12.4).**
Success gate = §11.5 (`/dev/spidev1.0` present, `spid` up with no error/crash, steady POWER
LED, then `t2-cli list --usb` → `USB␉…`).

### 12.3 Flash-path blockers (two, both flashing-procedure — orthogonal to the CS1/DTS work)
Getting an image to actually *write* on a hop ≥ 18.06 exposed **two independent t2-cli/OpenWrt
flash-path bugs**, both of which silently no-op'd the flash (transfer succeeds, "Finished"
prints, device reboots into the *old* release). Neither has anything to do with the CS1/DTS
fix. **Blocker A** = the sysupgrade image-metadata compat check (below); **Blocker B** = t2-cli
clobbering the device's `/lib/upgrade/common.sh` (found on 18.06→19.07, now fixed in t2-cli —
see §12.3.1).

**Blocker A — cross-version sysupgrade `supported_devices` metadata mismatch:**

- `node …/tessel-2.js update --usb --openwrt-path <18.06.bin> -n` **transfers** the 3.67 MB
  image and prints *"Finished"*, **but the device stays on 17.01** (`uname` = 4.4.182 /
  LEDE) even after a clean power-cycle — the image was **not written**.
- **Root cause:** OpenWrt `sysupgrade` (17.01+) runs `fwtool_check_image`, which compares the
  image's appended `supported_devices` metadata against the **running board's device-tree
  `compatible`** and refuses on mismatch. `Device/tessel` (`image/mt7620.mk`) sets **no
  `SUPPORTED_DEVICES`**, so it defaults to the profile name `tessel`, while the board's DT
  root `compatible = "tessel,tessel2", "wrtnode", …`. `tessel` ∉ the board compatibles →
  **refused.** The **visible sysupgrade log** (once Blocker B was fixed and device output was
  no longer swallowed) confirmed it verbatim:
  ```
  [sysupgrade] Device tessel,tessel2 not supported by this image
  [sysupgrade] Supported devices: tessel
  [sysupgrade] Image check 'fwtool_check_image' failed but force given -- will update anyway!
  [sysupgrade] Commencing upgrade. Closing all shell sessions.
  ```
  ⇒ The running board identifies as **`tessel,tessel2`** (its DT compatible), *not* the legacy
  `board_name()` value. **Correction to the earlier analysis:** the `/tmp/sysinfo/board_name =
  "generic"` finding (below) is the **legacy `board_name()` path** — real, but *not* the check
  that fires here. The operative 18.06+ gate is **`fwtool_check_image` on the DT compatible
  `tessel,tessel2`**, so the correct permanent fix is `SUPPORTED_DEVICES := tessel tessel2`
  (matching `compatible = "tessel,tessel2"`), **not** adding `generic`.
- **Why only now:** this metadata compat check exists in 17.01+ but **not in 15.05**, which
  is exactly why factory(15.05)→17.01 flashed clean and 17.01→18.06 refuses. It will recur
  on **every** hop from 17.01 upward.
- **Legacy `board_name()` note (secondary, not the operative gate):** on ramips,
  `/tmp/sysinfo/board_name` is written by `ramips_board_detect()`
  (`target/linux/ramips/base-files/lib/ramips.sh`) from a `case "$machine"` over the DTS
  `model` string. **There is no "Tessel 2" case**, so `$name` stays empty, the function
  `return`s early *without writing* the file, and `board_name()`
  (`package/base-files/.../functions.sh:351`) falls back to the literal `"generic"`. This
  affects `board_name`-keyed config/upgrade paths but is **not** what `fwtool_check_image`
  compares (that uses the DT compatible). Baking a self-ID fix into a NEW image still cannot
  remove the force for the hop that flashes *onto* it (the running *source* is unchanged).
- t2-cli invokes `sysupgrade -n` with **no force** (`lib/tessel/commands.js:145`,
  `lib/tessel/update.js:81-88`) → no built-in override.

**Immediate unblock (parent, in the main repo's t2-cli submodule — this worktree has no
submodules):** an opt-in, env-gated force in `lib/tessel/update.js` — when
`T2_FORCE_FLASH` is set, splice `-F` into the `sysupgrade` command (mirrors the
`T2_RESTORE_URL` convention; default behaviour unchanged). Forcing is **safe here**: the
image is the correct `ramips/mt7620` tessel build; only the cosmetic
`supported_devices` mismatch trips the check, and restore recovery remains
available. **Validated on hardware:** `T2_FORCE_FLASH=1` wrote 18.06 for real (device
booted `OpenWrt 18.06.9`, hostname flipped LEDE→OpenWrt).

### 12.3.1 Blocker B — t2-cli clobbered the device's `/lib/upgrade/common.sh` (the real repeat no-op; fixed in t2-cli)
The 19.07 flash silently no-op'd **twice** before device-side output was visible. Root cause
(fixed by the parent in this repo's t2-cli):

- Before every sysupgrade, t2-cli's `fixOldUpdateScripts()` **overwrote the running system's
  `/lib/upgrade/common.sh`** with a bundled **Chaos-Calmer-era** copy
  (`resources/openwrt/common.sh`). That legacy file's only Tessel purpose is a `kill_remaining()`
  that skips `spid`/`usbexecd`.
- But **18.06+ refactored sysupgrade** to pivot into a ramfs and **moved `kill_remaining`/
  `run_ramfs` out of `common.sh`, renaming the flash routine to `do_upgrade_stage2`.** So on
  18.06 the clobber (a) gave **zero** spid benefit and (b) **deleted `do_upgrade_stage2`** →
  sysupgrade called a now-undefined flash routine → **rebooted WITHOUT writing** → back to
  18.06. This is why 17.01→18.06 worked (17.01 matched the old file's era) but 18.06→19.07
  didn't — and it would have bitten **every** subsequent hop and the 24.10 jump too.
- **Fix (t2-cli):** made `fixOldUpdateScripts()` **version-aware** — it reads the pristine
  `/rom/lib/upgrade/common.sh`; if that contains `do_upgrade_stage2` (modern), it **restores**
  it over any clobbered overlay copy and **skips** the legacy override (which now only applies
  to genuinely old images). It also **self-heals** an already-clobbered device. Added
  `[sysupgrade]` stdout/stderr logging (gated on `T2_FORCE_FLASH`) so device-side output is no
  longer swallowed — which is how Blocker A's exact message finally became visible.

**Candidate PERMANENT fixes for Blocker A (to weigh) — force stays required for in-flight hops regardless:**
- **(a) A proper t2-cli `--force-flash` CLI flag** (instead of the env var) — a clean,
  discoverable override for the whole hop series. Belongs in t2-cli, not the image.
- **(b) Make images self-ID correctly** — the *correct* lever is **not** `/etc/board.d`
  (those scripts consume `board_name`, they don't set it) but either a **`case` for
  `"Tessel 2"` added to `ramips_board_detect()`** (brittle: patches a huge upstream file) or,
  cleaner for the overlay, a **small preinit hook** writing `board_name`. **Caveat (proven at
  source):** this only affects the *running* system once such an image is installed, so it can
  never remove the force for a hop whose *source* image predates it.
- **(c) Pragmatic chain-wide unblock: `SUPPORTED_DEVICES := tessel tessel2`** on
  `Device/tessel` (matching the board's DT `compatible = "tessel,tessel2"` that
  `fwtool_check_image` actually reads). This makes every built image *accept* the running
  Tessel board, so **no force is needed on any hop**. Clean and semantically correct — this is
  the recommended permanent fix.

**Recommendation / decision:** keep `T2_FORCE_FLASH` as the operational unblock for the
mechanical series now (proven safe, and required for 18.06→19.07 anyway since the *source*
image predates any fix). **Do not entangle a `SUPPORTED_DEVICES` change into a per-hop DIAG
build** — that would add an untested delta to an otherwise single-delta hop and muddy its
hardware verdict. Fold the permanent fix (prefer **(c)** `SUPPORTED_DEVICES := tessel tessel2`
for a clean chain-wide force-free result, optionally plus **(b)** for correct legacy self-ID)
into an **isolated rebuild** after the mechanical series, at/around the 21.02 pivot. Blocker B
is already fixed in t2-cli. **Status: 18.06 flashed & booted via force and fully
hardware-validated (§12.4); 19.07 flashed via force after the Blocker-B fix (§13, HW verdict
pending); permanent Blocker-A fix deferred to the pivot rebuild.**

### 12.4 Hop 2 (18.06) hardware validation RESULT — PASS ✅
Flashed with `T2_FORCE_FLASH=1` (the metadata-gate force from §12.3) — which wrote the image
for real (the earlier `-n` attempt silently no-op'd on the `fwtool_check_image`
`supported_devices` mismatch, `tessel,tessel2` vs `["tessel"]` — see §12.3 Blocker A).

- **Boot:** `OpenWrt 18.06.9, r8077-7cbbab7246` / `Linux OpenWrt 4.14.206`. Hostname flipped
  LEDE→OpenWrt (expected — 18.06 dropped the LEDE branding). Force override confirmed working.
- **CS1 fix HOLDS on k4.14:** `/dev/spidev1.0` present (`153, 0`); `dmesg: spi spi1.0: force
  spi mode3`; **zero** `spi_device register error`. The single-line `"spi refclk"` pin-37 trim
  is runtime-equivalent to the 17.01 fix — proven, not just build-verified.
- **t2-cli end-to-end:** `list --usb` → `USB␉OpenWrt`. Bridge works host→coprocessor→spid→MT7620.
- **Residual (non-fatal):** same `buggy DT: spidev listed directly in DT` WARN (warns-but-creates)
  — the k5.x hard refusal is still the 21.02 item. POWER LED steady (pin-38 freed by the patch).
- **Transient startup race (benign):** the first `spid` instance logged `Error connecting to USB
  Daemon socket /var/run/tessel/usb: No such file or directory` (spid raced ahead of `usbexecd`
  creating the socket); procd respawned it and `spid[1038]` came up and serviced the connection.
  **This is a self-healing startup order race, NOT a crash loop and NOT the spidev-registration
  error.** Flag for later hops: if it ever fails to self-heal, add a procd `after`/dependency on
  `usbexecd`; benign at 18.06.

**⇒ Hop 2 (18.06) is FULLY hardware-validated. The "17.01→19.07 mechanical" model is now
runtime-proven at BOTH 17.01 and 18.06.**

## 13. Hop 3 (19.07) — CS1 patch clean; boot panic on first flash → rootfs mtdsplit fix (HARDWARE-VALIDATED)
19.07 is also kernel **4.14** with the **same** stock `mt7620n.dtsi` group name `"spi refclk"`,
so the hop-2 `patches-4.14/999-tessel-mt7620-spi-cs1.patch` **drops straight in with zero
changes** — the single strongest confirmation that the k4.14 port is release-general.

### 13.1 Build-source verification (19.07, kernel 4.14.275) — PASS
- Patch applies **clean** (no `.rej`, no fuzz) into the 19.07 tree's `patches-4.14/`.
- Patched `mt7620.c`: `FUNC("spi refclk", 0, 37, 1)` + `GRP("spi refclk", …)` (name unchanged).
- Compiled `image-Tessel.dtb`: `spi@b40` `status="okay"`, `pinctrl-0` → the `"spi refclk"`
  pingroup; child `spidev@0 compatible="spidev" reg=<0x0>`; alias `spi1 → spi@b40`.
- `world` build **exit 0**. DIAG artifact:
  `build/openwrt-incremental/output/tessel-19.07-DIAG.bin`
  (copy of `openwrt-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin`, 3.8 MB;
  sha256 `E47AC2775C55312D65C2F5B78E3881098EC161CF99142B21AAA0C6968E2BA87D`).

**Status: built + build-source-verified; awaiting hardware flash/verify.** Flash with
`T2_FORCE_FLASH=1` (the running board's DT compatible `tessel,tessel2` ∉ image
`supported_devices:["tessel"]`, so `fwtool_check_image` refuses without force — §12.3
Blocker A). Also requires the t2-cli common.sh-clobber fix (§12.3.1) or the flash silently
no-ops. Success gate = §11.5 (`/dev/spidev1.0`, `spid` up no error/crash, steady POWER LED,
then `t2-cli list --usb` → `USB␉OpenWrt`). The 21.02 pivot stays parked until 19.07 is
hardware-validated.

### 13.2 Hop 3 (19.07) FIRST HARDWARE VERDICT — boot panic; a NEW hard break localized (rootfs mtdsplit)
The first 19.07 DIAG flash (via force + the §12.3.1 common.sh fix) **wrote and booted the kernel
but panicked before userspace** — a genuinely NEW divergence the incremental method caught, and it
is **NOT** the CS1/spid work (that is upstream of userspace and was untestable until boot).

**Symptom (full u-boot→kernel→panic captured over the SAMD21 USB CDC console):**
- Kernel 4.14.275 boots, `MIPS: machine is Tessel 2`, `spi spi0.0`/`spi spi1.0 force spi mode3`
  both appear (so the CS1 DTS is fine), the 4 flash partitions are created:
  `u-boot / u-boot-env / factory / firmware (0x50000-0x2000000)`.
- **Then:** `VFS: Cannot open root device "(null)" ... error -6` → `Kernel panic - not syncing:
  VFS: Unable to mount root fs on unknown-block(0,0)` → reboot loop. Kernel cmdline has **no
  `root=`** and the only mtdblocks are `mtdblock0..3` (the 4 raw partitions).
- **Smoking gun:** the "firmware" partition is **never split** into `kernel` + `rootfs` — there is
  no `2 uimage-fw partitions found` line and no `mtd: setting mtdX (rootfs) to be root filesystem`.
  With no rootfs block device there is nothing to mount → panic. (This also matches the user's
  "POWER blinking, no WiFi, faint ERR" — Linux never reached userspace.)

**Root cause (pinned at build-source level; 18.06 vs 19.07 upstream diff):** ramips changed **how
the firmware partition is split** between 18.06 and 19.07:
- **≤18.06 (k≤4.14):** split is **name-based** — `CONFIG_MTD_SPLIT_FIRMWARE=y` makes
  `mtd_partition_split()` run the FIRMWARE-type parsers on any partition labelled `"firmware"` that
  has no `compatible`. 18.06's `mtdsplit_uimage.c` `uimage-fw` parser also has **no** `of_match_table`.
  So a bare `label = "firmware"` is enough. (Confirmed: 18.06 `mt7620/config-4.14:160` has
  `CONFIG_MTD_SPLIT_FIRMWARE=y`; 18.06 `WRTNODE.dts` firmware partition is bare.)
- **≥19.07:** the name-based split **code still exists** (`generic/pending-4.14/402-mtd-use-typed-
  mtd-parsers-*` still defines `split_firmware()`), but 19.07 **dropped `CONFIG_MTD_SPLIT_FIRMWARE`
  from the mt7620 defconfig** (it is `# not set`), so the name-based path is compiled out. In
  parallel 19.07 **added** a DT-driven path — `mtdsplit_uimage.c` gains
  `.of_match_table = { .compatible = "denx,uimage" }` (`#if LINUX_VERSION >= 4.9`) — which upstream
  boards adopt (19.07 `WRTNODE.dts` added `compatible = "denx,uimage"` *inside a `fixed-partitions`
  wrapper*). So on 19.07 a firmware partition splits via **either** the DT `compatible` **or** the
  re-enabled name-based config — but **not** with a bare `label="firmware"` and no config.
- Our release-agnostic `Tessel.dts` carried the **bare `label = "firmware"`** (no `compatible`),
  which booted at 17.01/18.06 (their defconfig had `CONFIG_MTD_SPLIT_FIRMWARE=y`) but panics at
  19.07 (config dropped, no `compatible` → neither path fires → no split → no rootfs).
  **Correction to the first hypothesis:** the gap is a **kernel config symbol**
  (`CONFIG_MTD_SPLIT_FIRMWARE`), *not* a missing DTS `compatible`. `CONFIG_MTD_SPLIT_UIMAGE_FW` is a
  red herring (=y in both). See the two fix attempts below — the DTS `compatible` approach was tried
  first and **failed on hardware**.

**Fix — ATTEMPT 1 (FAILED on hardware): bare-child `compatible = "denx,uimage"`.** The first
attempt added `compatible = "denx,uimage";` directly to the firmware partition, on the theory that
19.07's DT-driven parser (`of_match_table = {"denx,uimage"}`) would then match it. **This REGRESSED
the partition table** and still panics. Full boot log: `soc-1907-denxuimage-regression.log`.
- BEFORE (bare, no compatible): `Creating 4 MTD partitions` — u-boot / u-boot-env / factory /
  **firmware** (present but unsplit).
- AFTER (bare child + `compatible`): `3 fixed-partitions partitions found` — the **firmware
  partition VANISHES entirely** (only u-boot / u-boot-env / factory) → still no rootfs → panic.
- **Why:** our partitions are **bare children of the flash node** (`m25p80@0`), with **no
  `partitions { compatible = "fixed-partitions"; … }` wrapper**. In that legacy layout, a partition
  leaf that itself carries a `compatible` is **disqualified from fixed-partitions enumeration**, so
  the node is skipped and never created. A nested `compatible` is only legal (and only DT-matched)
  when the partition sits *inside* a `fixed-partitions` container — which is exactly how upstream
  `WRTNODE.dts` declares it. Our bare layout can't use the one-line DT approach without also adding
  the wrapper.

**Fix — ATTEMPT 2 (adopted; mirrors validated 18.06): re-enable NAME-BASED split via kernel config.**
The name-based split code **still exists** in 19.07's k4.14 tree — `generic/pending-4.14/402-mtd-
use-typed-mtd-parsers-for-rootfs-and-firmware-split.patch` adds `split_firmware()` /
`mtd_partition_split()`, which runs the FIRMWARE parsers on a partition **iff**:
```c
IS_ENABLED(CONFIG_MTD_SPLIT_FIRMWARE) &&
!strcmp(part->mtd.name, SPLIT_FIRMWARE_NAME /* "firmware" */) &&
!of_find_property(mtd_get_of_node(&part->mtd), "compatible", NULL)   // node must have NO compatible
```
19.07 merely **dropped `CONFIG_MTD_SPLIT_FIRMWARE` from the mt7620 defconfig** (it is `# not set` in
`generic/config-4.14`); 18.06's `mt7620/config-4.14:160` had it `=y` (verified in-tree — the *only*
`MTD_SPLIT_*` symbol that differs between the two; both share JIMAGE/SEAMA/TPLINK/**UIMAGE**). So the
fix is:
1. **Revert the DTS to a bare firmware partition** (no `compatible`) — byte-identical to the
   17.01/18.06-validated layout. The `!of_find_property(…,"compatible")` guard above *requires* it
   to be bare; a `compatible` would both break enumeration **and** disable the name-based split.
2. **Inject `CONFIG_MTD_SPLIT_FIRMWARE=y` into the mt7620 kernel config fragment** from `build.sh`
   `apply_overlay()` (`target/linux/ramips/mt7620/config-<kver>`). It is a **kernel** symbol, so a
   top-level `config.seed` entry is silently dropped by `make defconfig` — it must go in the target
   fragment, which is where 18.06 carried it.

This makes 19.07's firmware-split behaviour **identical to hardware-validated 18.06** (same bare
4-partition layout, same name-based split, same `CONFIG_MTD_SPLIT_UIMAGE_FW=y` parser). The
DT-driven `denx,uimage` + `fixed-partitions` wrapper approach is the eventual upstream idiom but is
**deferred** to whichever later hop actually removes the name-based `split_firmware` code (a bigger,
structural DTS change; not needed while patch 402 is still present).

**Model update:** the "17.01→19.07 is purely mechanical" claim is **further refined** — 19.07 needed
a small, bounded, runtime-only fix (re-enable name-based firmware mtdsplit) that pure build analysis
of 17.01/18.06 could not surface, exactly like the CS1 break at 17.01. Two independent hard breaks
are now runtime-proven in the ≤19.07 band: **CS1 SPI registration (17.01)** and **firmware
mtdsplit config drop (19.07)**. The CS1 fix is DTS; the mtdsplit fix is a one-line kernel-config
injection (DTS deliberately unchanged from the validated layout).

**Status: ATTEMPT 2 HARDWARE-VALIDATED ✓ (commit `b12d0b0`, DIAG sha256 `E1586930493D21D74CEE9955
24C86819240908D86D9C330CA2BCD19A2BB10146`).** Flashed via the spid-free repackaged-restore path and
captured over the USB serial console + console root shell. **The firmware partition now SPLITS** —
the exact thing attempt 1 / the original lacked:
```
cat /proc/mtd →
  mtd3: 01fb0000 "firmware"
  mtd4: 0018727b "kernel"       ← NEW (carved from firmware)
  mtd5: 01e28d85 "rootfs"       ← NEW (root mounts from here)
  mtd6: 01c20000 "rootfs_data"  ← NEW (overlay)
```
No VFS panic; `mount_root` mounted the overlay, procd/init/kmodloader ran, userspace reached. **All
gates pass:**
- OpenWrt 19.07.10 r11427-9ce6aa9d8d, `uname` 4.14.275 ✓
- `/dev/spidev1.0` present (crw 153,0) — **CS1 fix holds unchanged on k4.14** ✓
- `dmesg`: `spi spi0.0` + `spi spi1.0 force spi mode3`; **zero** `spi_device register error` ✓
- `spid[1031] Starting` (no "Error opening SPI device", no crash-loop) + `usbexecd[1065]` both up ✓
- WiFi up: `wlan0` link ready, `br-lan` port2(wlan0) forwarding ✓
- host: `t2 list --usb` → `USB␉OpenWrt` ✓
- Only the expected non-fatal WARN: `/palmbus@10000000/spi@b40/spidev@0: buggy DT: spidev listed
  directly in DT` — **predicted; becomes a HARD refusal at k5.x/21.02** → whitelist a non-generic
  compatible on the coprocessor node then (see §14).

**Hop chain 17.01 ✓ / 18.06 ✓ / 19.07 ✓ are now ALL hardware-validated.** Commit `b12d0b0` is the
good one; `a2fd3a6` (denx,uimage) stays superseded/bad. The 21.02 pivot is **UNPARKED** (§14).

## 14. Hop 4 (21.02, kernel 5.4) — THE PIVOT: source-scoping results (verify-then-defer)

19.07 (k4.14) is the top of the "k4.x band"; 21.02 jumps to **kernel 5.4**, long predicted as the
pivot where the spid/spidev/GPIO bridge finally breaks. **Source investigation of the real
`v21.02.7` tree materially shrank the predicted scope** — most of the feared k5.x breaks do NOT
actually fire at 5.4. The incremental method's core payoff: the breaks are not where we guessed.

### 14.1 What the source actually shows at 5.4 (each predicted break, checked in-tree)

| Predicted k5.x break | Reality at 21.02 / k5.4 (verified in `v21.02.7` tree + mainline 5.4) | Action |
|---|---|---|
| **spidev "buggy DT" becomes a HARD refusal** | **FALSE at 5.4.** Mainline 5.4 `drivers/spi/spidev.c` `spidev_probe()` still only emits a **non-fatal `WARN(... "buggy DT: spidev listed directly in DT")`** and then **creates `/dev/spidevX.Y` anyway** — same as k4.14. The SPI core also still has the modalias fallback (`strcmp(spi->modalias, "spidev")`), so a `compatible = "spidev"` node binds. Whitelist (e.g. `rohm,dh2228fv`) not required yet. | **DEFER** the whitelist to the hop that truly hard-refuses (verify `/dev/spidev1.0` appears on 21.02 hardware first). |
| **sysfs `/sys/class/gpio` removed → spid GPIO must move to libgpiod** | **FALSE at 5.4.** `CONFIG_GPIO_SYSFS=y` is **default** in `target/linux/generic/config-5.4:1850`. `/sys/class/gpio` works, so `spid`'s sysfs-GPIO code (IRQ=2, SYNC=1, gpiochip base 0) runs unchanged. The mt7620 `ralink,gpio-base = <0>` is kept in the 5.4 dtsi, so the global sysfs numbers still resolve. `spid-start` is already release-agnostic. | **DEFER** the libgpiod port to the hop that removes/disables sysfs GPIO. |
| **firmware mtdsplit changes (cf. the 19.07 panic)** | **NON-ISSUE at 5.4.** `CONFIG_MTD_SPLIT_FIRMWARE=y` is **default** in `target/linux/ramips/mt7620/config-5.4:250` (19.07 was the anomaly that dropped it), and the name-based `split_firmware` code (generic `pending-5.4/402-*`) is still present. Our bare `label="firmware"` partition splits exactly as on validated 18.06/19.07. (The harness still injects `=y` as belt-and-suspenders.) | None (works). |
| **CS1 SPI-registration fix must be re-ported to k5.4** | **MECHANICAL.** The pinmux group table `arch/mips/ralink/mt7620.c` `refclk_grp[] = { FUNC("spi refclk", 0, 37, 3) }` is **byte-identical** between mainline 4.14 and 5.4, and `mt7620n.dtsi` still has `spi1: spi@b40` + `spi_cs1` with group name `"spi refclk"`. The pin-37 trim patch drops into `patches-5.4/` with the same context. | Ported: `overlay/patches/ramips/patches-5.4/999-tessel-mt7620-spi-cs1.patch`. |
| **build system / toolchain churn** | **ONE new break: the container.** 21.02's `make defconfig` prereq requires **Python ≥3.5 + python3-distutils**; the Ubuntu 18.04 image only had Python 2 → `Prerequisite check failed`. First hop to drop Python 2. | Fixed: added `python3 python3-dev python3-distutils python3-setuptools` to the Dockerfile. |
| **SUPPORTED_DEVICES / flash self-accept** | Board DT compatible is `tessel,tessel2`; images list only `tessel` → cross-version sysupgrade needs `-F` (§12.3 Blocker A). | Added `SUPPORTED_DEVICES := tessel,tessel2 tessel tessel2` to `Device/tessel` so images self-accept (parent still flashes with force; harmless). |

### 14.2 Net: the 21.02 "pivot" is far smaller than feared — one real bridge delta

Boot/bridge-critical functional deltas over the validated 19.07 recipe reduce to **just the CS1
pin-37 patch ported to `patches-5.4`** (same as every hop so far), plus two harness fixes that are
**not** bridge logic: the container `python3` prereq and the (optional) `SUPPORTED_DEVICES` flash
convenience. The two "big pivot" items — the **spidev whitelist** and the **libgpiod GPIO port** —
are **provably not needed at 5.4** and are **deferred** to whichever later hop (22.03/k5.10,
23.05/k5.15, or 24.10/k6.6) actually (a) hard-refuses a `compatible="spidev"` node or (b) drops
`CONFIG_GPIO_SYSFS`. That is exactly the localisation the incremental method exists to produce:
the 24.10 "undebuggable" bridge failure is now bounded to *one of those two upstream changes*, at a
*specific* later hop, rather than a monolithic k4.14→k6.6 leap.

**Status: 21.02 DIAG building** (first 21.02 build compiles a fresh k5.4 toolchain). On exit 0:
verify the CS1 patch applied (no `.rej`), DTB shows `spi@b40` + `spidev@0`, firmware partition bare;
record sha256; hand parent. Hardware gate = §11.5 **plus** the two verify-then-defer probes:
(1) does `/dev/spidev1.0` still enumerate at k5.4 (spidev warn-but-create holds)? and (2) does
`spid` bring up the bridge over sysfs GPIO unchanged? If both hold, 21.02 is validated with a
near-mechanical delta and the real pivot work moves to a later, still-single hop.
