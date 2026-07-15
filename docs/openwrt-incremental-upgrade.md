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
| 2 | 18.06 | 4.14 | build-system / feed deltas; spidev **"buggy DT" warning** first appears (k4.14, node still created); **CS1 fix ported to k4.14** (see §12) | ✅ *(CS1-fixed DIAG built; HW-pending)* | mechanical + trivial 1-line pinmux port |
| 3 | 19.07 | 4.14 | same kernel as 18.06 → spidev warning persists (node still created) | ✅ *(monitor)* | mechanical — **last easy hop** |
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
POWER LED are the expected runtime result. **Status: built + build-source-verified;
awaiting hardware flash/verify.** Success gate = §11.5 (`/dev/spidev1.0` present, `spid`
up with no error/crash, steady POWER LED, then `t2-cli list --usb` → `USB␉…`).

### 12.3 Flash gate found: cross-version sysupgrade board_name/supported_devices mismatch
The first 18.06 flash attempt exposed a **flashing-procedure** blocker *before* the CS1 fix
could even be tested (the image never boots, so this is orthogonal to the DTS/pinmux work):

- `node …/tessel-2.js update --usb --openwrt-path <18.06.bin> -n` **transfers** the 3.67 MB
  image and prints *"Finished"*, **but the device stays on 17.01** (`uname` = 4.4.182 /
  LEDE) even after a clean power-cycle — the image was **not written**.
- **Root cause (pinned):** OpenWrt `sysupgrade` (17.01+) compares the *running* system's
  `board_name` (`/tmp/sysinfo/board_name`) against the image's appended
  `supported_devices` metadata and refuses on mismatch. The Tessel target never set a
  `board.d` board name, so **17.01 self-reports `board_name = "generic"`**, while the built
  18.06 image advertises `{"supported_devices":["tessel"],"version":{…"18.06.9"…}}`. `"generic"`
  ∉ `["tessel"]` → **sysupgrade exits without writing.**
- **Why only now:** this metadata compat check exists in 17.01+ but **not in 15.05**, which
  is exactly why factory(15.05)→17.01 flashed clean and 17.01→18.06 refuses. It will recur
  on **every** hop from 17.01 upward.
- t2-cli invokes `sysupgrade -n` with **no force** (`lib/tessel/commands.js:145`,
  `lib/tessel/update.js:81-88`) → no built-in override.

**Immediate unblock (parent, in the main repo's t2-cli submodule — this worktree has no
submodules):** an opt-in, env-gated force in `lib/tessel/update.js` — when
`T2_FORCE_FLASH` is set, splice `-F` into the `sysupgrade` command (mirrors the
`T2_RESTORE_URL` convention; default behaviour unchanged). Forcing is **safe here**: the
image is the correct `ramips/mt7620` tessel build; only the cosmetic
`board_name`/`supported_devices` mismatch trips the check, and restore recovery remains
available.

**Two candidate PERMANENT fixes (to weigh):**
- **(a) A proper t2-cli `--force-flash` CLI flag** (instead of the env var) — a clean,
  discoverable override for the whole hop series. Belongs in t2-cli, not the image.
- **(b) Set the Tessel `board_name` via `/etc/board.d` in the build overlay** so images
  self-identify as `"tessel"` (cleaner long-term; also lets `board_name`-keyed config land
  correctly). **Caveat:** it does **not** help flashing *from* an already-`"generic"` system
  (17.01), so a force is still required for the current hop and any hop whose *source* image
  predates the board.d fix. Net: (b) is the right long-term hygiene fix **for images we
  build going forward**, but (a)/force is what actually unblocks the in-flight hops.

**Recommendation:** keep the `T2_FORCE_FLASH` env force as the operational unblock for the
hop series now; adopt **(b)** in the overlay so every image we build from here on self-IDs
as `tessel` (harmless, removes the mismatch for future *source* systems), and optionally
promote the env force to a real `--force-flash` flag **(a)** if this graduates beyond the
uplift. **Status: parent re-flashing 18.06 with `T2_FORCE_FLASH=1` to get the boot + CS1
verdict; overlay board.d change held until 18.06 is confirmed booting.**
