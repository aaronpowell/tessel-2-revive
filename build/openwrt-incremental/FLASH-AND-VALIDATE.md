# Hop 1 (OpenWrt 17.01) — flash & validate

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
$img = "build\openwrt-incremental\output\openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin"
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
ls -l /dev/spidev*             # EXPECT: /dev/spidev0.1 (NOT 32766.1)
ls -l /var/run/tessel/         # EXPECT: sockets 0,1,2 + usb,port_a,port_b symlinks
logread | grep -i spid         # EXPECT: "spid: Starting"; NO fatal(...) lines
ps | grep -E 'spid|usbexecd'   # EXPECT: both daemons running
```
Failure signatures to report back:
- `Error opening SPI device /dev/spidevX.Y` → bus number wrong (adjust `spid-start`)
- `Error opening /sys/class/gpio/export` / GPIO fatal → sysfs GPIO numbering
- no `/dev/spidev*` at all → spidev didn't bind (DT `compatible`)

## 3. Gate check — does t2-cli connect + run?
Streaming commands run forever; redirect to a file rather than piping to Out-String.
```powershell
Start-Process -FilePath node `
  -ArgumentList '.\repos\t2-cli\bin\tessel-2.js','version','--usb' `
  -RedirectStandardOutput out\ver.txt -NoNewWindow
Get-Content out\ver.txt -Wait        # look for the version banner / HW hello

# Smoke test: run a script on-device
node .\repos\t2-cli\bin\tessel-2.js run tessel-scripts\hello.js --usb
```
**PASS** = `version --usb` connects promptly and `run` executes. That proves the
incremental method for hop 1 → advance to 18.06.

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
