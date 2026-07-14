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
| 1 | 17.01 "Reboot" | 4.4 | **SPI bus renumber** `32766 → 0` | ✅ *(1-line `spid.sh` fix)* | mechanical |
| 2 | 18.06 | 4.14 | build-system / feed deltas; spidev **"buggy DT" warning** first appears (k4.14, node still created) | ✅ | mechanical |
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
| **SPI bus number** (`/dev/spidev32766.1`) | 17.01 (k4.4) | Modern Ralink SPI driver → bus `0`. Fix in `spid.sh`; verify actual node on boot (`ls /dev/spidev*`). Optionally pin via a DT `aliases { spi0 = &spi0; }`. |
| **spidev DT compatible** | warns **18.06** (k4.14), hard 21.02 (k5.4) | `spidev_probe()` at k4.14 does `WARN(of_device_is_compatible(node,"spidev"), "buggy DT…")` — **warn-only, node still created** (verified in source, see §8). Both 18.06 and 19.07 are k4.14. Fix at the pivot: change DTS `compatible` to a whitelisted string (e.g. `rohm,dh2228fv`) or patch spidev's `of_device_id` table. |
| **sysfs GPIO base / availability** | 21.02 (k5.4) → gone by 24.10 (k6.6) | gpiochip base dynamic → global `2`/`1` wrong; `CONFIG_GPIO_SYSFS` not default; interface removed later. Port `spid.c` to **libgpiod / `/dev/gpiochipN`**, addressing lines by `(chip, offset)`. |
| **Device tree churn** | ongoing | mt7620 DTS moved to `dtsi` includes + `&label` overlays; re-express the Tessel board over each release's WRTnode/mt7620n base. |
| **Switch: swconfig → DSA** | 22.03 / 23.05 | ramips DSA conversion is staged; affects `network` config + `board.d`. Off the USB/`spid` critical path but needed for LAN/SSH + hw smoke tests. |
| **Firewall: iptables → nftables/fw4** | 22.03 (k5.10) | Default config only; regenerate `firewall` config. |
| **Build system** | 21.02+ | `urngd` (parent's CMake CRT-probe workaround), `rules.mk`/staging visibility, musl/toolchain bumps, package `Makefile` format. |
| **tessel-tools / tessel packages** | per hop | Watch for patches that stop applying and `config.mk` `PACKAGES` entries renamed/dropped upstream (e.g. `python` → `python3`, `usb-modeswitch`, `mjpg-streamer`). |

---

## 4. Earliest release where the bridge breaks (deliverable 2)

There is **no single clean break**. The bridge unravels in **three stages**:

1. **Earliest — cosmetic / mechanical:** the **SPI bus number** at **17.01 (k4.4)**.
   One-line `spid.sh` change (`/dev/spidev32766.1` → `/dev/spidev0.1`).
2. **First break needing a DTS change:** the **spidev whitelist** — *warns* at
   **19.07 (k4.14)**, becomes *hard* by **21.02 (k5.4)**. Requires a whitelisted
   `compatible` in the DTS.
3. **Deepest break — forces new code (the real cause of the 24.10 failure):**
   **sysfs-GPIO → libgpiod**. Begins at **21.02** (base renumber + not default), and
   is **unavoidable by 24.10 (k6.6)** once sysfs GPIO is gone.

> **⇒ The pivotal porting release is 21.02 (kernel 5.4).** It is the first hop where
> **both** a DTS spidev-compatible change **and** the GPIO character-device (libgpiod)
> port become mandatory. Everything at or below **19.07** is mechanical config work;
> **21.02 is where the genuine driver/bring-up engineering lands.** Hops 22.03 → 24.10
> then become comparatively mechanical once 21.02 is solved, plus the switch/firewall
> config migrations.

---

## 5. Go / no-go validation gate (every hop)

Run in order; do not advance to the next hop until all pass. Any bad flash is
recoverable, so experimentation is safe.

1. **Build** — clean upstream release + Tessel overlay produces
   `…/openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin`.
2. **Flash** *(human, OS-only)* —
   `node repos/t2-cli/bin/tessel-2.js update --usb --openwrt-path <bin>`
   (firmware handoff stays out of scope; hardware is at the human's desk).
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
