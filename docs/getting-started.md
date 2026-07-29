# Getting Started — Flash and Run

> Upstream reference: [T2 CLI docs](https://tessel.gitbooks.io/t2-docs/content/API/CLI.html) | [USB debugging](https://tessel.gitbooks.io/t2-docs/content/Debugging/USB.html) | [Root access](https://tessel.gitbooks.io/t2-docs/content/Debugging/Root_Access.html)

This guide covers the full path from a fresh board to a running app using the revived fork. **Primary host environment: Windows 11 / WSL2.**

---

## Prerequisites

### Windows
- Node.js LTS (install from [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS`)
- [usbipd-win](https://github.com/dorssel/usbipd-win) v4+ for attaching USB to WSL: `winget install usbipd`
- Git for Windows (for cloning)

### WSL2 (Ubuntu)
- Node.js LTS (`nvm` recommended)
- `npm`, `git`
- `build-essential` (needed if any native npm modules need compiling)

---

## 1. Clone the CLI

**Option A — Windows native (recommended for USB/flashing)**
```powershell
git clone https://github.com/aaronpowell/t2-cli.git
cd t2-cli
npm install
```

**Option B — WSL2**
```bash
cd /home/aaron/code/github/tessel/t2-cli
npm install
npm link   # makes `t2` available globally in WSL
```

---

## 2. Verify the CLI finds the board

Plug in the Tessel 2 via USB, then:

```powershell
# Windows
node .\bin\tessel-2.js list
```
```bash
# WSL
t2 list
```

You should see something like:
```
INFO Searching for nearby Tessels...
    USB    Tessel-XXXX
```

**If WSL doesn't see the board:** attach it with usbipd first (PowerShell, admin):
```powershell
usbipd list             # find the "Tessel 2" entry, note BUSID
usbipd attach --wsl --busid <busid>
```
> Note: If `usbipd attach` fails with a VBoxUsbMon error, upgrade usbipd: `winget upgrade usbipd`. That error was a false positive in older versions.

---

## 3. Provision the board

Provisioning sets up SSH keys so subsequent commands (update, run, push) can authenticate.

```powershell
node .\bin\tessel-2.js provision
```

This works over USB without any prior setup. You only need to do this once per board per machine.

---

## 4. Flash updated firmware and OpenWrt

### Option A — flash the released production image (recommended)

Download the `new_build_*.tar.gz` restore bundle from
[**Releases**](https://github.com/aaronpowell/tessel-2-revive/releases/latest) — it contains
OpenWrt 25.12.5 (kernel 6.12.94) with on-device Node.js 8.11.3 and the Tessel JS runtime.

`t2 restore` fetches over HTTP, so serve the file locally and point `T2_RESTORE_URL` at it:

```powershell
# in the folder containing the downloaded tarball
python -m http.server 8765
```

Then, from `repos/t2-cli`:

```powershell
$env:T2_FORCE_FLASH = '1'
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/new_build_2512-prod-node8-r2.tar.gz'
node .\bin\tessel-2.js restore --usb
```

Writing takes ~35 seconds and ends with `INFO Restore successful`.

> ⚠️ **`t2 restore` does not reboot the board — physically unplug and replug it.** First boot
> then takes **~3 minutes** (it formats the jffs2 overlay and runs first-boot scripts). Be
> patient before assuming a failure.

> ⚠️ **`t2 restore` is destructive to device identity.** It bulk-erases the flash and writes a
> newly randomised MediaTek factory partition, so the board gets a **new WiFi MAC** — and
> therefore a new default hostname — each time you restore.

After it comes up, the board names itself `tessel-<release>-<mac4>` (e.g.
`tessel-v25-12-5-node8-r2-fc2c`) rather than the stock `OpenWrt`. Rename it with
`t2 rename <name>`.

Full procedure, validation gates, and how to build the image yourself:
[`production-image-and-release.md`](./production-image-and-release.md).

### Option B — push locally-built artifacts

If you've built your own artifacts (e.g. in WSL, reachable from Windows via
`\\wsl.localhost\Ubuntu\...`), push them to the running OS instead:

```powershell
node .\bin\tessel-2.js update `
  --firmware-path \\wsl.localhost\Ubuntu\home\aaron\code\github\tessel\t2-firmware\build\firmware.bin `
  --openwrt-path  \\wsl.localhost\Ubuntu\home\aaron\code\github\tessel\openwrt\bin\ramips\openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin
```

This takes **2–3 minutes**. The board reboots automatically when done. Set `T2_FORCE_FLASH=1`
to force the sysupgrade (`-F`) and bypass the image compatibility check.

> **DFU / bootloader mode is not required** for this path — the update is pushed over SSH/USB to the running OS.  
> If you do need DFU mode (e.g. full recovery of a non-booting board): unplug, hold the button near the logo, plug in while holding, then release after 2–3 seconds. You should see an amber blinking LED.
>
> Note that `t2 update` can still fail at the firmware bootloader handoff even when the OpenWrt
> transfer succeeds — Option A is the more dependable path.

---

## 5. Confirm the update

```powershell
node .\bin\tessel-2.js version
```

Expected output:
```
INFO Tessel Environment Versions:
INFO t2-cli: 0.1.23
INFO t2-firmware: 0.2.0
INFO Node.js: 8.11.3
```

---

## Recovery fallback (2016 factory restore image)

If you need to go all the way back to the original stock firmware — or the production bundle
above is unavailable — use the archived upstream factory image:

`https://web.archive.org/web/20201102173433/https://s3.amazonaws.com/builds.tessel.io/custom/new_build_next.tar.gz`

```powershell
$env:T2_RESTORE_URL = "https://web.archive.org/web/20201102173433/https://s3.amazonaws.com/builds.tessel.io/custom/new_build_next.tar.gz"
node .\bin\tessel-2.js restore --usb
```

> This reverts the board to **OpenWrt 15.05 (2015, kernel 3.18) with Node.js 4.2.1** — the
> unmaintained factory state, including the old SSH/TLS stack. Prefer the release bundle in
> step 4 unless you specifically need stock firmware.

---

## 6. Hello world app

Create a project directory and write a minimal app:

```powershell
mkdir hello-tessel
cd hello-tessel
npm init -y
npm install tessel
```

Create `index.js`:
```js
var tessel = require('tessel');

console.log('Hello from revived Tessel!');

var led0 = tessel.led[0];
var led1 = tessel.led[1];

setInterval(function() {
  led0.toggle();
  led1.toggle();
  console.log('blink');
}, 500);
```

Run it on the board:
```powershell
node ..\t2-cli\bin\tessel-2.js run .\index.js
```

**Expected result:**
- `Hello from revived Tessel!` printed in the console
- `blink` printed every 500 ms
- LED 0 and LED 1 alternating on the board

---

## 7. Using a hardware module

Example with the climate module (temperature + humidity):

```powershell
npm install climate-si7020
```

```js
var tessel = require('tessel');
var climatelib = require('climate-si7020');

var climate = climatelib.use(tessel.port['A']);

climate.on('ready', function() {
  setInterval(function() {
    climate.readTemperature('f', function(err, temp) {
      climate.readHumidity(function(err, humid) {
        console.log('Temp:', temp.toFixed(4) + 'F', 'Humidity:', humid.toFixed(4) + '%RH');
      });
    });
  }, 300);
});
```

---

## LED reference

| LED | Colour | Normal meaning |
|-----|--------|---------------|
| `tessel.led[0]` | Green | User-controlled |
| `tessel.led[1]` | Blue | User-controlled |
| Power LED | Blue | Board is powered and running |
| ERR LED | Red | Error / pressed config button |

---

## Useful t2 commands

```bash
t2 list                    # find boards (USB + LAN)
t2 provision               # set up SSH keys on a board
t2 version                 # print device firmware/OS/Node versions
t2 run <file>              # run a script (live, streams logs back)
t2 push <file>             # deploy a script to run on boot
t2 update                  # update firmware + OS from manifest
t2 update --firmware-path  # update with explicit local firmware.bin
t2 update --openwrt-path   # update with explicit local sysupgrade.bin
t2 wifi --ssid X --pass Y  # configure WiFi
t2 root                    # open a root SSH shell on the device
t2 erase                   # erase all deployed scripts
```

Full CLI reference: [tessel.gitbooks.io/t2-docs/content/API/CLI.html](https://tessel.gitbooks.io/t2-docs/content/API/CLI.html)

---

## Rebuilding artifacts from source

If you want to rebuild firmware or the OpenWrt image yourself rather than using pre-assembled artifacts:

### SAMD21 firmware (WSL or Linux)
```bash
cd repos/t2-firmware
# requires gcc-arm-none-eabi
make
# output: build/firmware.bin, build/boot.bin
```

### OpenWrt image (Windows, Linux, or macOS — via Docker)
```powershell
# Works natively from Windows PowerShell with Docker Desktop installed.
# No need to clone openwrt separately — the container handles it.
git clone https://github.com/aaronpowell/t2-build.git
cd t2-build
docker compose run --rm build
# output appears in ./output/
```

The first run takes 1–2 hours (downloads sources + full build). Subsequent runs reuse the build cache and are much faster.

For a shell inside the build environment:
```powershell
docker compose run --rm shell
```
