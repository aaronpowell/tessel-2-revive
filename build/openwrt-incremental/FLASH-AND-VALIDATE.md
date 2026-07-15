# Hop 1 (OpenWrt 17.01) — flash & validate

> **✅ Update (hop 1 FULLY HARDWARE-VALIDATED):** the plain 17.01 image first booted to a
> black box (POWER blinks, USB enumerates, t2-cli never connects). Root cause was the
> coprocessor **CS1 SPI device failing to register**; the fix (coprocessor → `&spi1`
> `spidev@0` = `/dev/spidev1.0`, plus the pin-37-only `spi_cs1` kernel pinmux patch) is
> now **proven correct AND sufficient on real hardware** — see
> `docs/openwrt-incremental-upgrade.md` §11. All gate items pass: `/dev/spidev1.0` present,
> `spid` up/stable, coprocessor CS registers, **POWER LED steady**, and
> `t2-cli list --usb` → **`USB␉LEDE`**. The steps below are the validation path; use the
> `-DIAG` image (WiFi-AP, flash `-n`) from `DIAGNOSE-17.01-WIFI-AP.md` when you also want
> an SSH shell for `logread`/`dmesg`.

> **⚠️ Host-side USB stall recipe (IMPORTANT — read before flashing).** The flash/connect
> path is prone to severe **`LIBUSB_TRANSFER_STALL`**. Each stalled *or* force-killed t2-cli
> op **halts the USB data endpoint until the next device power-cycle** — retrying without a
> power-cycle just re-stalls and wastes time. Reliable recipe:
> 1. **Power-cycle the Tessel** (physical unplug/replug) and use a **direct USB port** with
>    a known-good cable (avoid hubs/long runs).
> 2. Kill any lingering `node …tessel-2.js` (see §0) — it holds the USB handle.
> 3. Run **exactly one** t2-cli op (flash *or* restore *or* list). If it stalls, **go back
>    to step 1** — don't hammer it.
> This recipe carried both the restore and the DIAG flash to success this session. Expect to
> repeat it per-op on future hops.

> **Flashing is human-supervised** (the board is at your desk). This is **OS-only**
> (`--openwrt-path`), so the SAMD21 firmware/bootloader handoff is skipped — that path
> is unreliable and out of scope. Any bad flash is fully recoverable (see §4).

All commands run from the repo root on the host, using the t2-cli **script** (not a
global `t2`). Kill any lingering CLI process first — it holds the USB handle.

## 0. Pre-flight
```powershell
# Kill any stuck CLI holding the USB device
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.CommandLine -match 'tessel-2\.js' } |
  ForEach-Object { Stop-Process -Id $_.Id -Force }

# Confirm the board is seen (factory image connects in seconds)
node .\repos\t2-cli\bin\tessel-2.js list --usb
```

## 1. Flash the 17.01 image (OS only)
```powershell
$img = "build\openwrt-incremental\output\lede-ramips-mt7620-tessel-squashfs-sysupgrade.bin"
node .\repos\t2-cli\bin\tessel-2.js update --usb --openwrt-path $img
```
Expect `Finished updating Tessel with local builds.`, then the board reboots and
re-enumerates on USB. A physical replug may be needed after the reboot.

## 2. Gate check — is the `spid` bridge up?  (the whole point of the hop)
SSH in (17.01 ships a current dropbear, so the legacy KEX flag is usually *not*
needed; if it is: add `-oKexAlgorithms=+diffie-hellman-group1-sha1`):
```powershell
ssh root@192.168.1.1            # or root@tessel.local
```
On the device:
```sh
ls -l /dev/spidev*             # EXPECT: /dev/spidev1.0 (coprocessor on &spi1/CS0)
ls -l /var/run/tessel/         # EXPECT: usb socket + port_a/port_b symlinks
logread | grep -i spid         # EXPECT: "spid[NNN]: Starting"; NO "Error opening SPI device"
ps | grep -E 'spid|usbexecd'   # EXPECT: both daemons running
```
> A single non-fatal `spidev spi1.0: buggy DT: spidev listed directly in DT` WARN is
> **expected and harmless** at 17.01/k4.4 — the node is still created. It only becomes a
> hard refusal at k5.x (the 21.02 whitelist item).

Failure signatures to report back:
- `Error opening SPI device /dev/spidevX.Y` → node missing (check `&spi1` enabled + the
  `spi_cs1` pinmux patch applied; `spid-start` autodetects `/dev/spidev*`)
- `spi_device register error /…/spidev@1` → CS1 fix regressed (coprocessor back on `&spi0`)
- `Error opening /sys/class/gpio/export` / GPIO fatal → sysfs GPIO numbering (a k5.x item)
- no `/dev/spidev*` at all → spidev didn't bind (DT `compatible` / `&spi1` disabled)

## 3. Gate check — does t2-cli connect + run?
The quickest end-to-end proof is `list --usb`, which reads the on-device hostname over the
full bridge (host → coprocessor → spid over SPI → MT7620 → `uci get hostname`):
```powershell
node .\repos\t2-cli\bin\tessel-2.js list --usb   # EXPECT: "USB  LEDE"  (hop 1 validated)
```
Streaming commands (`version`/`run`) run forever; redirect to a file rather than piping to
Out-String:
```powershell
Start-Process -FilePath node `
  -ArgumentList '.\repos\t2-cli\bin\tessel-2.js','version','--usb' `
  -RedirectStandardOutput out\ver.txt -NoNewWindow
Get-Content out\ver.txt -Wait        # look for the version banner / HW hello

# Smoke test: run a script on-device
node .\repos\t2-cli\bin\tessel-2.js run tessel-scripts\hello.js --usb
```
**PASS** = `list --usb` shows `USB␉LEDE` (achieved on hop 1) and `run` executes. That proves
the incremental method for hop 1 → advance to 18.06.

## 4. Recovery (if the board won't come back)
```powershell
# Terminal A: serve the factory tarball locally
python -m http.server 8765   # run from the folder containing new_build_next.tar.gz

# Terminal B:
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/new_build_next.tar.gz'
node .\repos\t2-cli\bin\tessel-2.js restore --usb
```
Restore is reliable (bulk erase → U-Boot → factory → SquashFS). Replug if a new USB
open stalls.

## What to report back to the parent session
- The exact `/dev/spidev*` node name that appeared (confirms the bus-number theory).
- Whether `spid`/`usbexecd` stayed up (`logread`), and any `fatal(...)` line verbatim.
- Whether `version --usb` / `run` connected.
This tells us hop 1 is mechanical-only (as predicted) and unblocks 18.06 → 19.07.
