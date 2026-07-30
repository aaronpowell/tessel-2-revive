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
git clone https://github.com/aaronpowell/t2-cli.git
cd t2-cli
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
	USB	tessel-lab-bench
	LAN	tessel-lab-bench
```

> **`t2 list` never exits.** It keeps scanning until you interrupt it, so it is fine
> interactively but will hang any script or agent that waits for it. Run it with a
> timeout, or start it in the background, sleep ~15 s, read its output, then kill it.
>
> **Its output goes to stderr, not stdout** — redirect `2>&1` if you are capturing it.

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

> **`t2 provision` has no `--usb` flag.** It is USB-only by definition, and passing
> `--usb` fails with `'--usb' expects a value` because the global flag parser tries to
> consume the next argument.

> **Discovery can need a second attempt.** `t2 provision` and the commands that follow
> it race the discovery/authorisation probe, so the first one or two invocations can
> report `No Authorized Tessels Found` and then succeed unchanged. Retry before
> concluding anything is wrong.

---

## 4. Flash updated firmware and OpenWrt

### Option A — flash the released production image (recommended)

The latest release on
[**Releases**](https://github.com/aaronpowell/tessel-2-revive/releases/latest) ships
OpenWrt 25.12.5 (kernel 6.12.94) with on-device Node.js 8.11.3 and the Tessel JS
runtime. Which asset you want depends on where the board is starting from:

| Board is on… | Use | Command |
|---|---|---|
| Old firmware (15.05 factory), an unknown image, or not booting | `tessel-restore.tar.gz` | `t2 restore --usb` |
| A 25.12 production image already | `tessel-update.tar.gz` | `t2 update` (USB only) |

**Restore (the from-anywhere path).** `t2 restore` defaults to
`releases/latest/download/tessel-restore.tar.gz` from this repo, so on a machine with
internet access you need no arguments and no download:

```powershell
$env:T2_FORCE_FLASH = '1'
node .\bin\tessel-2.js restore --usb
```

To flash a specific release, or to work offline, download the asset, serve it locally,
and point `T2_RESTORE_URL` at it:

```powershell
# in the folder containing the downloaded tarball
python -m http.server 8765
```
```powershell
$env:T2_FORCE_FLASH = '1'
$env:T2_RESTORE_URL = 'http://127.0.0.1:8765/tessel-restore.tar.gz'
node .\bin\tessel-2.js restore --usb
```

> ⚠️ Before starting that server, **check port 8765 is actually free**. A server left
> running from an earlier attempt will keep serving its *old* tarball, and the flash
> will silently succeed against the wrong image.

Writing takes ~35 seconds and ends with `INFO Restore successful`.

> ⚠️ **`t2 restore` does not reboot the board — physically unplug and replug it.** First boot
> then takes **~3 minutes** (it formats the jffs2 overlay and runs first-boot scripts). Be
> patient before assuming a failure.

> ⚠️ **`t2 restore` is destructive to device identity.** It bulk-erases the flash and writes a
> newly randomised MediaTek factory partition, so the board gets a **new WiFi MAC** — and
> therefore a new default hostname — each time you restore. It also does not preserve
> your configuration; `t2 update` does.

**Update (board already on a 25.12 image).** This is the non-destructive path — it
preserves WiFi config, a `t2 rename`d hostname, and your authorized keys:

```powershell
node .\bin\tessel-2.js update
```

It reads [`releases/builds.json`](../releases/builds.json) from this repo to find the
newest build. Note that **`t2 update` requires USB** — over LAN it connects and then
aborts with *"Must have Tessel connected over USB to complete update."*

After it comes up, a restored board names itself `tessel-<release>-<mac4>` (e.g.
`tessel-v25-12-5-node8-r5-fc2c`) rather than the stock `OpenWrt`. Rename it with
`t2 rename <name>`.

Full procedure, validation gates, and how to build the image yourself:
[`production-image-and-release.md`](./production-image-and-release.md).

### Option B — push locally-built artifacts

If you've built your own artifacts, push them to the running OS with explicit paths.
Replace `<repo-root>` with wherever you cloned this repository:

```powershell
node .\bin\tessel-2.js update `
  --firmware-path <repo-root>\repos\t2-firmware\build\firmware.bin `
  --openwrt-path  <repo-root>\build\openwrt-incremental\output\tessel-25.12-PROD-node8-r5.bin
```

> If you built in WSL and are driving the CLI from Windows, WSL paths are reachable
> from Windows as `\\wsl.localhost\<distro>\<path>` UNC paths.

This takes **2–3 minutes**. The board reboots automatically when done. Set `T2_FORCE_FLASH=1`
to force the sysupgrade (`-F`) and bypass the image compatibility check.

> **DFU / bootloader mode is not required** for this path — the update is pushed over SSH/USB to the running OS.  
> If you do need DFU mode (e.g. full recovery of a non-booting board): unplug, hold the button near the logo, plug in while holding, then release after 2–3 seconds. You should see an amber blinking LED.
>
> Updating between production releases (e.g. r4 → r5) is hardware-validated. Pushing an
> arbitrary locally-built image onto an unrelated base can still fail at the firmware
> bootloader handoff even when the OpenWrt transfer succeeds; `t2 restore` is the
> from-anywhere fallback if that happens.

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

> **`Detected a Tessel that may be booting` followed by `No Authorized Tessels Found`
> is often just a race, not a failure.** Discovery and the authorisation probe race each
> other, so the same command can fail and then succeed unchanged seconds later. Retry two
> or three times before investigating.
>
> Relatedly, `LIBUSB_TRANSFER_STALL` for up to about a minute after replugging a board is
> the board booting, not a bad flash. Wait it out.

To read anything else off the device, use [`tools/`](../tools/) — `t2-cli` has no
general "run a command on the board" verb, and `t2 root`/`t2 ssh` are LAN-only:

```powershell
node ..\..\tools\usb-exec.js "cat /etc/tessel-release"
node ..\..\tools\lan-exec.js <board-ip-or-hostname> "logread | tail -50"
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
