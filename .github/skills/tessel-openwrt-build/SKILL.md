---
name: tessel-openwrt-build
description: Use when building, patching, or debugging the Tessel 2 OpenWrt image — anything under build/openwrt-incremental/, kernel config symbols, the board DTS, ramips kernel patches, uci-defaults first-boot scripts, or moving the build to a new OpenWrt release. Covers where a kernel config option must actually go, why the DTS firmware partition must stay bare, and why first-boot config scripts must guard on the current config value. Trigger on "openwrt build", "build.sh", "sysupgrade image", "kernel config", "CONFIG_MTD_SPLIT_FIRMWARE", "CONFIG_MIPS_FP_SUPPORT", "Tessel.dts", "uci-defaults", "mtdsplit", "new openwrt hop".
---

# Building the Tessel 2 OpenWrt image

> **Verified: July 2026**, on the hop ladder ending at OpenWrt **25.12.5 / kernel 6.12.94**
> (release `v25.12.5-node8-r5`, `ab51d6a`). Every claim below about *which* OpenWrt release
> or kernel version has a given default is a statement about the tags this build actually
> walked — `v15.05.1` through `v25.12.5`. On a newer release, re-read the upstream default
> rather than trusting the version boundaries recorded here; that is exactly how
> `CONFIG_MTD_SPLIT_FIRMWARE` bit us in the first place.

## How the build is put together

`build/openwrt-incremental/` clones **stock upstream OpenWrt** at `OPENWRT_TAG` and applies
a thin overlay on top. Nothing is forked; every board-specific change is a file in
`overlay/`.

```bash
cd build/openwrt-incremental
OPENWRT_TAG=v25.12.5 docker compose run --rm build     # image lands in ./output/
OPENWRT_TAG=v25.12.5 docker compose run --rm shell     # poke at the build tree
```

`build.sh` has four modes — `build` (default), `prepare`, `world`, `shell`. `prepare` stops
after the overlay is applied, which is what you want when you need to inspect the merged
tree before a long compile.

Overlay layout, all consumed by `apply_overlay()`:

| Path | Becomes |
|---|---|
| `overlay/dts/Tessel.dts` | `target/linux/ramips/dts/Tessel.dts` |
| `overlay/tessel-tools/` | `package/tessel-tools/` (spid, usbexecd, init scripts) |
| `overlay/patches/ramips/patches-<kver>/` | `target/linux/ramips/patches-<kver>/` |
| `overlay/config.seed` | `.config`, then `make defconfig` |

Two `case` statements at the top of `build.sh` map the release tag to its feed branch and
its kernel-patch directory. **Adding a hop means adding a line to both** — kernel patches
are deliberately kept per-kernel-version so a 6.6 patch can never leak into a 6.12 build.
As of `ab51d6a` those maps cover `v15.05.1`…`v25.12.5` only; an unmapped tag will not
build, which is intentional — it forces you to decide the mapping rather than inherit a
wrong default.

The `Device/tessel` recipe is appended to `mt7620.mk` in one of two shapes, because 21.02
rewrote the ramips image-recipe conventions (`DTS`/`DEVICE_TITLE` → `SOC`/`DEVICE_DTS`/
`DEVICE_VENDOR`+`DEVICE_MODEL`). `build.sh` does not hardcode that boundary: it sniffs the
tree for `DEVICE_DTS = $$(SOC)_` and picks the matching block. That detection is why the
21.02 split has not needed revisiting through 25.12.5 — prefer extending the sniff over
adding a version comparison.

Environment switches: `TESSEL_DIAG=1` (diagnostic image), `TESSEL_INITRAMFS=1` (RAM-root
kernel for probing a board whose on-flash rootfs will not mount), `TESSEL_PROD=1` +
`TESSEL_NODE_PAYLOAD` + `TESSEL_RELEASE` (production image with node and a release marker).

## Kernel config symbols go in the kernel fragment, not the seed

This is the single most expensive lesson in the build.

A symbol added to `overlay/config.seed` (i.e. to the top-level `.config`) is **silently
dropped by `make defconfig`** if it is a *kernel* symbol rather than an OpenWrt buildroot
symbol. It must be appended to the target kernel config fragment:

```
target/linux/ramips/mt7620/config-<kver>     # preferred
target/linux/ramips/config-<kver>            # fallback
```

`build.sh` does exactly that — deleting any existing line first so the value is *forced*,
not merely appended alongside a conflicting one — for two symbols:

- **`CONFIG_MTD_SPLIT_FIRMWARE=y`** — 18.06's mt7620 defconfig had it; 19.07 dropped it,
  and it has stayed absent through 25.12.5. Without it the kernel never splits the
  `firmware` partition into kernel + rootfs, so
  there is no rootfs mtd, no `root=`, and the board panics with *unable to mount root fs*.
- **`CONFIG_MIPS_FP_SUPPORT=y`** — as of 25.12.5, OpenWrt's generic `config-6.12` ships
  `# CONFIG_MIPS_FP_SUPPORT is not set` because its own userspace is entirely soft-float.
  The MT7620's 24KEc core has no hardware FPU, so with the emulator stripped every
  userspace `cop1` instruction traps to SIGILL. **Node's float ABI does not save you** —
  V8's JIT emits `cop1` at *runtime* for JS Numbers regardless of how it was compiled, so
  both hard-float and soft-float builds die identically with `Illegal instruction`.

Both of those are *upstream defaults at a point in time*, not laws. Check the current
`config-<kver>` before assuming the override is still needed — and equally, before
assuming a newly-needed symbol is already set.

Symptom pattern to recognise: you set the symbol, the build succeeds, and the symbol is
absent from the built kernel's `.config`. Verify by grepping the *merged* kernel config in
the build tree, not the file you edited.

`CONFIG_TARGET_ROOTFS_INITRAMFS` is the mirror-image case: it *is* a buildroot symbol, but
`make defconfig` **defaults it to `y`** for ramips/mt7620, which would produce a RAM-root
image instead of a flashable squashfs. So `build.sh` writes it explicitly either way —
including an explicit `# ... is not set`, which survives `defconfig` where simple absence
does not.

## The DTS firmware partition must stay bare

```dts
partition@50000 {
        label = "firmware";
        reg = <0x50000 0x1fb0000>;
};
```

No `compatible`. The name-based mtdsplit fires **only** for a partition labelled `firmware`
that has *no* `compatible` property. Adding `compatible = "denx,uimage"` — which looks like
the more correct, more modern thing to do — breaks partition enumeration and the board
panics at boot.

The other DTS trap is version-gated by `build.sh`: from kernel 5.15 (which on this ladder
means OpenWrt 23.05 onward — 22.03 is k5.10), `spidev_of_check()`
hard-fails any node whose compatible list contains `"spidev"` **anywhere**, so the
coprocessor node's `compatible = "spidev"` is rewritten to the whitelisted
`"rohm,dh2228fv"` for k5.15+ only. No single string works on both sides of that boundary;
dual-listing does not help. The whitelist itself lives in `drivers/spi/spidev.c` and
upstream has added entries to it over time — if a future kernel drops
`rohm,dh2228fv`, the fix is to pick another whitelisted compatible, not to revert to
`"spidev"`. Verified working at k6.12.94.

## First-boot config scripts must guard on the current value

`files/etc/uci-defaults/98-tessel-wifi` and `99-tessel-hostname` are baked into the
**squashfs**. That means they re-run on the first boot of **every new rootfs** — including
after a config-preserving `sysupgrade` — and they run **after** preinit has restored the
user's config from `/sysupgrade.tgz`.

So an unconditional `uci set` there does not "set a default". It **overwrites the config
the update just restored**, silently un-joining the board from WiFi on every update, while
the backup and restore themselves worked perfectly.

**A marker file cannot be the guard.** The overlay is exactly what sysupgrade replaces, so
any marker written into it is wiped by the very event the guard has to survive. It also
does nothing for boards flashed before the marker existed.

Guard on the current **config value** instead:

```sh
cur_ssid="$(uci -q get wireless.@wifi-iface[0].ssid)"
case "$cur_ssid" in
        ''|OpenWrt|tessel-unconfigured)   # the three values that mean "unconfigured"
                uci -q set wireless.@wifi-iface[0].ssid='tessel-unconfigured'
                ...
                ;;
esac
```

`OpenWrt` must be in that list: it is the stock generated default a genuinely fresh flash
carries, so without it a clean flash never lands on the intended placeholder.

Related, and found the same way: `wifi detect` pins a **fixed** `radio0.channel` (ch 1).
Correct for an AP, wrong for a station — the radio parks on ch 1 and never scans 6/11, so
it never associates and `iwinfo wlan0 info` reports the board's own MAC as the access point
with `Channel: 0`, which reads exactly like a driver fault. Set `channel='auto'`.

Gate any change in this area with a real `t2 update` on a board that has config, and prove
the guard in both directions — see the `hardware-debugging-traps` skill.

## Related docs

- [`docs/openwrt-incremental-upgrade.md`](../../../docs/openwrt-incremental-upgrade.md) — the hop-by-hop journey
- [`docs/openwrt-upgrade-progress.md`](../../../docs/openwrt-upgrade-progress.md) — per-hop status
- [`docs/gaps-and-risks.md`](../../../docs/gaps-and-risks.md) — the config-loss investigation in full
