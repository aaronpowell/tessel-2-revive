# External References

All upstream Tessel documentation and related external resources. Many of these are read-only archives — the original project is unmaintained.

---

## Official Tessel 2 documentation

The canonical T2 documentation is hosted on GitBook and sourced from [github.com/tessel/t2-docs](https://github.com/tessel/t2-docs).

### API reference

| Document | URL |
|----------|-----|
| CLI reference | https://tessel.gitbooks.io/t2-docs/content/API/CLI.html |
| Hardware API (GPIO, SPI, I2C, UART, PWM) | https://tessel.gitbooks.io/t2-docs/content/API/Hardware_API.html |
| Modules (10-pin + USB) | https://tessel.gitbooks.io/t2-docs/content/API/Modules.html |
| Network API | https://tessel.gitbooks.io/t2-docs/content/API/Network_API.html |
| Supported Languages | https://tessel.gitbooks.io/t2-docs/content/API/Supported_Languages.html |

### Debugging

| Document | URL |
|----------|-----|
| **Technical Overview** (architecture, code deploy walkthrough) | https://tessel.gitbooks.io/t2-docs/content/Debugging/Technical_Overview.html |
| USB debugging | https://tessel.gitbooks.io/t2-docs/content/Debugging/USB.html |
| LAN discovery | https://tessel.gitbooks.io/t2-docs/content/Debugging/LAN_Discovery.html |
| Node.js debugging | https://tessel.gitbooks.io/t2-docs/content/Debugging/Node.js.html |
| Root access / SSH | https://tessel.gitbooks.io/t2-docs/content/Debugging/Root_Access.html |

### Hardware

| Document | URL |
|----------|-----|
| Tessel 2 hardware overview | https://tessel.gitbooks.io/t2-docs/content/Hardware/Tessel_2_Overview.html |
| 10-pin module specs | https://tessel.gitbooks.io/t2-docs/content/Hardware/Modules.html |

### Tutorials

| Document | URL |
|----------|-----|
| Communication protocols (SPI, I2C, UART) | https://tessel.gitbooks.io/t2-docs/content/Tutorials/Communication_Protocols.html |
| Interrupts | https://tessel.gitbooks.io/t2-docs/content/Tutorials/Interrupts.html |
| Making your own module | https://tessel.gitbooks.io/t2-docs/content/Tutorials/Making_Your_Own_Module.html |
| Pin pull-up/pull-down | https://tessel.gitbooks.io/t2-docs/content/Tutorials/pinpull.html |
| Pulse Width Modulation | https://tessel.gitbooks.io/t2-docs/content/Tutorials/Pulse_Width_Modulation.html |

### Glossary

https://tessel.gitbooks.io/t2-docs/content/GLOSSARY.html — definitions for CLI, GPIO, I2C, SPI, UART, LAN, ports, pins, etc.

---

## Getting started guide (original)

https://tessel.github.io/t2-start/ — The original T2 getting-started page (may be partially stale).

Source: [github.com/tessel/t2-start](https://github.com/tessel/t2-start)

---

## Chip datasheets

| Chip | Role | Datasheet |
|------|------|-----------|
| MediaTek MT7620n | SoC (runs OpenWrt + Node.js) | [MT7620 Datasheet (PDF)](http://www.anz.ru/files/mediatek/MT7620_Datasheet.pdf) |
| Atmel SAMD21 | Coprocessor (USB bridge, GPIO/SPI/I2C/UART/ADC) | [SAMD21 Datasheet (PDF)](http://www.atmel.com/images/atmel-42181-sam-d21_datasheet.pdf) |

---

## Original Tessel GitHub organisation

https://github.com/tessel — all original repos (unmaintained since ~2018–2020)

Key repos:

| Repo | Description |
|------|-------------|
| [tessel/project](https://github.com/tessel/project) | Governance, roadmap, code of conduct |
| [tessel/t2-docs](https://github.com/tessel/t2-docs) | Documentation source |
| [tessel/t2-cli](https://github.com/tessel/t2-cli) | Original CLI (upstream of fork) |
| [tessel/t2-firmware](https://github.com/tessel/t2-firmware) | Original firmware (upstream of fork) |
| [tessel/openwrt-tessel](https://github.com/tessel/openwrt-tessel) | OpenWrt build overlay (upstream of fork) |
| [tessel/openwrt](https://github.com/tessel/openwrt) | Custom OpenWrt fork (upstream of fork) |
| [tessel/t2-hardware](https://github.com/tessel/t2-hardware) | KiCad PCB/schematic design files |
| [tessel/t2-build](https://github.com/tessel/t2-build) | Build tooling (upstream of fork) |
| [tessel/t2-release](https://github.com/tessel/t2-release) | Release tooling (upstream of fork) |
| [tessel/uboot-mt7620](https://github.com/tessel/uboot-mt7620) | U-Boot bootloader (upstream of fork) |
| [tessel/t2-vm](https://github.com/tessel/t2-vm) | Virtual machine for testing (unmaintained, deferred) |
| [tessel/tessel-rust](https://github.com/tessel/tessel-rust) | Rust driver (out of scope for this revival) |

---

## Module library upstreams

| Module | npm | Upstream repo | Sensor/IC |
|--------|-----|--------------|-----------|
| ambient-attx4 | [npm](https://www.npmjs.com/package/ambient-attx4) | [tessel/ambient-attx4](https://github.com/tessel/ambient-attx4) | ATtiny + light/sound |
| climate-si7020 | [npm](https://www.npmjs.com/package/climate-si7020) | [tessel/climate-si7020](https://github.com/tessel/climate-si7020) | Si7020 temp+humidity |
| relay-mono | [npm](https://www.npmjs.com/package/relay-mono) | [tessel/relay-mono](https://github.com/tessel/relay-mono) | Dual relay |
| servo-pca9685 | [npm](https://www.npmjs.com/package/servo-pca9685) | [tessel/servo-pca9685](https://github.com/tessel/servo-pca9685) | PCA9685 PWM driver |
| accel-mma84 | [npm](https://www.npmjs.com/package/accel-mma84) | [tessel/accel-mma84](https://github.com/tessel/accel-mma84) | MMA8452Q accelerometer |

---

## OpenWrt references

| Resource | URL |
|----------|-----|
| OpenWrt project | https://openwrt.org |
| Creating packages | https://openwrt.org/docs/guide-developer/packages |
| Working with patches | https://openwrt.org/docs/guide-developer/patches |
| ramips/MT7620 target | https://openwrt.org/toh/hwdata/tessel/tessel_tessel_2 |

---

## OpenSSH legacy algorithm workaround

The current device firmware ships a very old Dropbear SSH that offers only `diffie-hellman-group1-sha1` and `diffie-hellman-group14-sha1` for key exchange — both considered legacy by modern OpenSSH clients.

OpenSSH reference: https://www.openssh.com/legacy.html

Workaround until OpenWrt is uplifted:
```bash
ssh -oKexAlgorithms=+diffie-hellman-group1-sha1 root@<tessel>.local -i ~/.tessel/id_rsa
```

---

## usbipd-win (Windows USB passthrough to WSL)

For attaching the Tessel USB device to WSL2:
- GitHub: https://github.com/dorssel/usbipd-win
- Install: `winget install usbipd`
- Requires v4+ (earlier versions had a spurious VBoxUsbMon error)

---

## Zadig (Windows USB driver tool)

If the `usb` npm package cannot open the Tessel device on Windows, use Zadig to install the WinUSB or libusbK driver:
- https://zadig.akeo.ie/
