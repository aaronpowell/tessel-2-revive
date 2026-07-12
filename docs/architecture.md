# Tessel 2 Architecture

> Upstream reference: [Technical Overview](https://tessel.gitbooks.io/t2-docs/content/Debugging/Technical_Overview.html) | [Tessel 2 Hardware Overview](https://tessel.gitbooks.io/t2-docs/content/Hardware/Tessel_2_Overview.html)
>
> For a narrative walkthrough of how all of this fits together (is OpenWrt a real Linux distro? does the board run a real Node.js binary? which npm packages can you push?), see [`how-it-works.md`](how-it-works.md).

## Hardware

The Tessel 2 has two processor chips that handle different responsibilities.

```
┌─────────────────────────────────────────────────────┐
│  Tessel 2 Board                                      │
│                                                      │
│  ┌──────────────────┐    SPI bus    ┌─────────────┐ │
│  │  MediaTek MT7620n│◄─────────────►│ Atmel SAMD21│ │
│  │  (SoC / "the     │               │ (coprocessor│ │
│  │   Linux side")   │               │ / "the MCU")│ │
│  │                  │               │             │ │
│  │  OpenWrt Linux   │               │ USB bridge  │ │
│  │  Node.js runtime │               │ GPIO/SPI/   │ │
│  │  WiFi + Ethernet │               │ I2C/UART/   │ │
│  │  2x USB Host     │               │ ADC control │ │
│  └──────────────────┘               └─────────────┘ │
│           │                               │          │
│           │ SPI Flash                     │ USB      │
│           │ (OpenWrt image)               │ (to host)│
└───────────┼───────────────────────────────┼──────────┘
            ▼                               ▼
       Internal storage             Host computer
       (sysupgrade.bin)          (t2-cli, Windows/WSL)
```

### MediaTek MT7620n (SoC)
- MIPS32 soft-float processor
- Runs OpenWrt Linux
- Manages WiFi, Ethernet, 2× USB Host ports
- Executes user JavaScript via Node.js
- Communicates with the SAMD21 over SPI

**Datasheet:** [MT7620 Datasheet (PDF)](http://www.anz.ru/files/mediatek/MT7620_Datasheet.pdf)

### Atmel SAMD21 (coprocessor)
- ARM Cortex-M0+ microcontroller
- Manages module port GPIO, SPI, UART, I2C, ADC
- Bridges USB communication to/from the SoC
- Provides USB serial console for SoC
- Programs SoC SPI flash over USB (prevents bricking)
- Manages SoC and module port power states

**Datasheet:** [SAMD21 Datasheet (PDF)](http://www.atmel.com/images/atmel-42181-sam-d21_datasheet.pdf)

### Module Ports (A and B)
- Two 10-pin connectors
- Support GPIO, SPI, UART, I2C, ADC per port
- Controlled by SAMD21 firmware
- Exposed to user code via Unix domain sockets `/var/run/tessel/port_a` and `/var/run/tessel/port_b`

---

## Software Stack

```
Host (Windows/WSL)                    Device (OpenWrt/MT7620)
──────────────────                    ───────────────────────

t2-cli (Node.js)
  │
  ├─── USB connection ─────────────►  SAMD21 USB bridge
  │     (usbpipe.c / bridge.c)           │
  │                                      │ SPI bus
  │                                      ▼
  │                                   spid (SPI daemon)
  │                                      │
  │                                      ├─► /var/run/tessel/usb
  │                                      ├─► /var/run/tessel/port_a
  │                                      └─► /var/run/tessel/port_b
  │
  ├─── SSH/LAN connection ──────────►  usbexecd (USB exec daemon)
        (SSH over WiFi/Ethernet)           │
                                           │ shell commands
                                           ▼
                                        Node.js process
                                           │
                                           │ require('tessel')
                                           ▼
                                        tessel.js / tessel-export.js
                                           │
                                           ▼
                                        /var/run/tessel/port_a|b
                                           │
                                           ▼
                                        SAMD21 GPIO/SPI/I2C/UART/ADC
```

### Key processes on the device

| Process | Source | Role |
|---------|--------|------|
| `spid` | `t2-firmware/soc/spid.c` | SPI daemon; bridges SPI↔domain sockets |
| `usbexecd` | `t2-firmware/soc/usbexecd.c` | Accepts shell commands over USB, routes stdio |
| `node` | OpenWrt package (`openwrt-tessel/package/node`) | Real Node.js **v8.11.3** binary at `/usr/bin/node`; executes user scripts |
| `tessel.js` | `t2-firmware/node/tessel.js` | Node module; connects to port domain sockets |

### On-device Node.js runtime

The device runs a genuine, unmodified-source **Node.js v8.11.3** cross-compiled for MIPS, packaged by [`openwrt-tessel/package/node/node/Makefile`](../repos/openwrt-tessel/package/node/node/Makefile). Key constraints baked into that build:

| Build flag | Effect |
|-----------|--------|
| `--with-mips-float-abi=soft` | Soft-float MIPS32; this is why **8.11.3 is the last Node that cross-compiles** for the MT7620 |
| `--v8-options="--max_old_space_size=20 ..."` | V8 heap capped at ~**20 MB** |
| `--without-inspector` | No `--inspect` / DevTools debugging on-device |
| `--without-intl` | No full ICU / `Intl` locale support |

Because the runtime is EOL Node 8, on-device scripts must stay within the Node 8 / ES2017 surface. Pure-JS npm packages deploy fine; native (C/C++) addons only work if a precompiled MIPS binary is available. See [`how-it-works.md`](how-it-works.md) §3 and §5 for the full picture, and [`gaps-and-risks.md`](gaps-and-risks.md) "Node.js version on device".

### Key source files (compatibility boundary)

These files define the **protocol contract** between host and device. Changes here have cross-layer implications and require careful co-ordination:

| File | Layer | Notes |
|------|-------|-------|
| `t2-cli/lib/usb-connection.js` | Host↔SAMD21 | USB framing, pipe protocol |
| `t2-cli/lib/lan-connection.js` | Host↔SoC | SSH command execution |
| `t2-firmware/soc/usbexecd.c` | SoC exec daemon | Null-delimited argv contract |
| `t2-firmware/soc/spid.c` | SoC↔SAMD21 | SPI bridge; domain socket routing |
| `t2-firmware/firmware/bridge.c` | SAMD21 firmware | SPI bridge magic/channel protocol |
| `t2-firmware/firmware/port.c` | SAMD21 firmware | CMD/REPLY enums for port control |
| `t2-firmware/node/tessel-export.js` | Node API | Maps JS API to port command bytes |
| `t2-firmware/node/tessel.js` | Node shim | Connects to `/var/run/tessel/port_{a,b}` |
| `openwrt-tessel/package/tessel/tools/Makefile` | Build | Package install paths and symlinks |

### Independently changeable surfaces

- CLI UX, discovery logic, deploy/push commands
- LAN vs USB transport internals (they share an abstract `Connection` interface)
- Crash reporter, update-notifier, logging
- Host-side JS module bundling/uglification

---

## SPI Bridge Protocol (summary)

The MT7620 and SAMD21 communicate over SPI using a custom framing protocol:

1. **Setup phase** — SoC drives SYNC low; both sides exchange a header containing magic number, channel availability bits, and per-channel data lengths
2. **Data phase** — SoC drives SYNC high; DMA transfers channel payloads in channel order
3. **Three channels:**
   - Channel 0 → USB pipe (CLI communication)
   - Channel 1 → Module Port A
   - Channel 2 → Module Port B

> Deep dive: [`t2-firmware/README.md`](https://github.com/aaronpowell/t2-firmware/blob/master/README.md)

---

## Code deploy walkthrough

```
t2 run index.js
      │
      ▼
t2-cli bundles + compresses the project
      │
      ▼ USB or SSH
SoC receives: tar, extract to /tmp/remote-script
      │
      ▼
usbexecd runs: node /tmp/remote-script/index.js
      │
      ▼
user code: var tessel = require('tessel')
      │
      ▼
tessel.js connects to /var/run/tessel/port_a and /port_b
      │
      ▼
port commands (e.g. led[0].high()) → byte arrays → domain socket
      │
      ▼
spid forwards to SAMD21 over SPI
      │
      ▼
SAMD21 firmware executes GPIO/peripheral command
```

---

## OpenWrt image

The device OS is a custom build of OpenWrt (legacy Barrier Breaker era, targeting `ramips/mt7620`).

- Image type: `squashfs-sysupgrade`
- Output: `openwrt/bin/ramips/openwrt-ramips-mt7620-tessel-squashfs-sysupgrade.bin`
- Build environment: Ubuntu 18.04 container via `t2-build/openwrt-env.sh`

See [`repos.md`](repos.md) for details on the build process.
