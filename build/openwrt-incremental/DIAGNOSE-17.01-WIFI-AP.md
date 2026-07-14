# Hop 1 (17.01) — Wi-Fi-AP diagnostic image: flash, join, pull logs

> **Context.** The clean 17.01 image flashed OK but boots to a **black box**: USB
> re-enumerates, but POWER blinks forever and t2-cli never connects — same symptom as
> 24.10. We have **zero device visibility** (no serial, dead bridge). This image bakes a
> first-boot **WPA2 access point** so that *if Linux boots at all* we can SSH in over
> Wi-Fi and read `logread`/`dmesg` — turning the black box into something diagnosable.
>
> It also doubles as the **clean-config test**: we flash with `-n` (no config carry-over),
> which directly tests the top suspect (CC-15.05 `/etc/config` preserved onto LEDE 17.01).

**Image:** `build\openwrt-incremental\output\lede-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin`
**AP SSID:** `Tessel-Diag`  ·  **Wi-Fi passphrase:** `tesseldiag`  ·  **SSH:** `root@192.168.1.1` password `tesseldiag` (fallback: empty password)

---

## 1. Flash — parent, over USB (board is on the working factory image now)

```powershell
# Kill any lingering CLI holding the USB handle
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.CommandLine -match 'tessel-2\.js' } |
  ForEach-Object { Stop-Process -Id $_.Id -Force }

# Confirm the factory image connects
node .\repos\t2-cli\bin\tessel-2.js list --usb

# Flash the DIAG image with a CLEAN config (-n => on-device `sysupgrade -n`,
# so NO CC-15.05 config is carried over and the baked AP defaults take effect).
$img = "build\openwrt-incremental\output\lede-ramips-mt7620-tessel-squashfs-sysupgrade-DIAG.bin"
node .\repos\t2-cli\bin\tessel-2.js update --usb --openwrt-path $img -n
```

Expect `Configuration is not saved during update.` then `Finished updating Tessel with
local builds.` The board reboots and re-enumerates. A physical replug may be needed.

> The `-n` flag is a stock t2-cli option (`bin/tessel-2.js` → `lib/tessel/update.js`
> `sysupgradeNoSaveConfig` → `sysupgrade -n`). No custom build was needed for the clean
> flash itself; the DIAG rebuild only adds the Wi-Fi AP.

---

## 2. Join the AP + pull logs — human (laptop at the desk)

1. Wait ~60–90 s after flashing for first boot (uci-defaults generates the AP, then a
   `wifi reload` brings it up). The amber `wlan` LED should activity-blink once the radio
   is up.
2. On the laptop Wi-Fi list, join **`Tessel-Diag`** (WPA2), passphrase **`tesseldiag`**.
3. SSH in and capture logs:
   ```sh
   ssh root@192.168.1.1          # password: tesseldiag  (or just Enter if empty works)
   # --- on the device ---
   logread  > /tmp/logread.txt
   dmesg    > /tmp/dmesg.txt
   uci show wireless             > /tmp/wireless.txt
   # targeted bridge evidence:
   logread | grep -iE 'spid|usbexec|spi|gpio' ; echo '---'
   ls -l /dev/spidev*           2>&1
   ps | grep -iE 'spid|usbexec' | grep -v grep
   ls -l /var/run/tessel/       2>&1
   ```
4. Copy the files back from the laptop (new shell, not inside the ssh session):
   ```sh
   scp root@192.168.1.1:/tmp/logread.txt  .
   scp root@192.168.1.1:/tmp/dmesg.txt    .
   scp root@192.168.1.1:/tmp/wireless.txt .
   ```
   (Windows: `scp` ships with OpenSSH; run from PowerShell.)

Paste `logread.txt` + `dmesg.txt` back to the parent session.

---

## 3. Reading the result (what each outcome means)

| Observation | Meaning | Next step |
|---|---|---|
| **AP appears, SSH works** | **Linux booted fine.** The black box is *after* userspace init — almost certainly the spid bridge, not an early kernel/init hang. | Inspect `spid` evidence (above). If `/dev/spidev*` exists but `spid` died → mechanical (bus number / spid-start). If no `/dev/spidev*` → DT `compatible`. Either way it's a **localized bridge fix**, still below the 21.02 pivot. |
| **POWER now steady but no AP** *(if AP config failed)* | Booted, but Wi-Fi didn't come up. | Re-flash and retry; check amber LED; fall back to UART (§4). |
| **No AP after 2–3 min, POWER still blinking** | **Boot hangs before userspace/Wi-Fi** — earlier than the bridge. Wi-Fi can't help. | **UART serial console (§4)** — the only remaining window. |
| **Clean `-n` flash made POWER go steady** (vs. blinking on the config-save flash) | **Config carry-over was the boot-breaker** (parent suspicion #1 confirmed). | Bridge work proceeds on a cleanly-booting 17.01. |

---

## 4. UART serial console — gold-standard fallback (task C)

If even the Wi-Fi-AP boot yields nothing, the hang is very early (bootloader/kernel/init)
and only a serial console will show it. The Tessel 2 kernel is already configured for it:
the DTS sets `bootargs = "console=ttyS0,115200"` (MT7620 UART0).

- **Adapter:** any 3.3 V USB-TTL (FT232/CP2102/CH340). **Do not** use a 5 V adapter.
- **Signals:** MT7620 UART0 **TX / RX / GND** (115200 8N1). On Tessel 2 these are the
  SoC UART0 pads near the MediaTek SoC (no RJ45/serial header is populated — expect to
  tack onto the TX0/RX0 test points; cross TX↔RX, share GND, leave VCC disconnected).
- **Capture:** PuTTY / `screen /dev/ttyUSB0 115200` / `pyserial-miniterm COMx 115200`.
- **Value:** shows U-Boot handoff, kernel decompress, the full `dmesg`, and the exact
  line where a very-early hang stalls — the one thing neither USB nor Wi-Fi can reveal.

---

## 5. Recovery (unchanged — reliable)

```powershell
# Terminal A (folder with new_build_next.tar.gz):
python -m http.server 8765
# Terminal B:
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/new_build_next.tar.gz'
node .\repos\t2-cli\bin\tessel-2.js restore --usb
```
Bulk erase → U-Boot → factory → SquashFS. Replug if a USB open stalls.
