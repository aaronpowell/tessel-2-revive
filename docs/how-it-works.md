# How It All Works — A Deep Dive

> Companion to [`architecture.md`](architecture.md). Where `architecture.md` is a reference (diagrams + tables), this doc is the narrative explainer: it answers "how does running JavaScript on this board *actually* work?" Every technical claim is grounded in a file in this repo or its submodules; upstream links corroborate framing.

## TL;DR

1. **OpenWrt is a genuine, full Linux distribution** — just one built for embedded routers. It has a Linux kernel, a BusyBox userspace, a package manager (`opkg`), an init system (`procd`), SSH, and WiFi/Ethernet networking. It is *not* a bare-metal RTOS or a toy shim.
2. **The device runs a real Node.js binary** — stock upstream **Node.js v8.11.3**, cross-compiled for the board's MIPS CPU and installed at `/usr/bin/node`. Same source you'd download from nodejs.org, just built for this chip.
3. **Which npm packages can you push?** Any **pure-JavaScript** package, *as long as it stays within the Node 8 / ES2017 language and API surface*. Packages with **native (C/C++) addons** only work if a precompiled MIPS binary exists — otherwise the deploy warns and breaks for that module.

---

## 1. The board is really two computers glued together

The single most important mental model: the Tessel 2 is **two processors** with completely different jobs. (See [`architecture.md`](architecture.md) for the full diagram.)

| Chip | What it is | Its job |
|------|-----------|---------|
| **MediaTek MT7620n** | A MIPS32 SoC — the same class of chip inside cheap home WiFi routers | Runs **OpenWrt Linux**, WiFi, Ethernet, USB host, and **your JavaScript via Node.js** |
| **Atmel SAMD21** | An ARM Cortex-M0+ microcontroller (no OS, bare-metal firmware) | Real-time control of the module-port pins (GPIO/SPI/I2C/UART/ADC), USB bridge to your host PC, and it flashes the SoC to prevent bricking |

Why two chips?
- **Real-time guarantees.** Linux is not a real-time OS; toggling a GPIO pin with precise timing is unreliable from a busy Linux userspace. The SAMD21 handles that deterministically.
- **Un-brickability.** The SAMD21 can reprogram the SoC's SPI flash over USB, so a bad OpenWrt image can always be recovered.

The "Linux side" (MT7620) is where JavaScript runs. The SAMD21 runs compiled C firmware (`t2-firmware/firmware/`), not Linux and not JavaScript.

---

## 2. OpenWrt: yes, it's a genuine Linux distro

OpenWrt is a complete operating system, not a stripped-down shim:

- A **Linux kernel** built for the `ramips/mt7620` target.
- A **userspace** — BusyBox provides `sh`, `tar`, `mkdir`, `mv`, `cat`, `ifconfig`, etc. The CLI relies on exactly these standard Unix commands when it deploys code (`mkdir -p`, `tar -x -C`, `mv`, `rm -rf`). ([`t2-cli/lib/tessel/commands.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/commands.js) lines 78–89)
- A **package manager**, `opkg` — the whole build system produces `.ipk` packages. Node itself is packaged this way (see §3).
- An **init system**, `procd` — Tessel's own services are registered as OpenWrt init scripts. The "run my app on boot" service: ([`openwrt-tessel/package/tessel/tessel-app/files/tessel-app.init`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/tessel/tessel-app/files/tessel-app.init))
  ```sh
  #!/bin/sh /etc/rc.common
  START=99
  USE_PROCD=1
  start_service() {
      procd_open_instance
      procd_set_param command /app/start
      procd_close_instance
  }
  ```
- **SSH** (Dropbear), **WiFi**, **Ethernet**, **DHCP/DNS** (`dnsmasq`, `odhcpd`) — standard OpenWrt networking. The CLI configures WiFi with `uci`/`ubus` calls. ([`t2-cli/lib/tessel/commands.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/commands.js) lines 69–76, 214–217)

Upstream Tessel describes it the same way: *"The primary processor of the Tessel 2 runs a very lightweight version of Linux called OpenWRT. OpenWRT provides all of the TCP/IP drivers, threading/schedule support, and runs Node, Rust or whatever other language you're using."* ([Tessel Technical Overview](https://tessel.gitbooks.io/t2-docs/content/Debugging/Technical_Overview.html))

### The specific OpenWrt build

The image is **OpenWrt 25.12.5 (kernel 6.12.94)** targeting `ramips/mt7620`, packaged
as a `squashfs-sysupgrade` image (~11 MB). It is squashfs-compressed because the board
has tens of MB of flash, and that size constraint still explains many of the
limitations below. See [`architecture.md`](architecture.md) "OpenWrt image" and
[`production-image-and-release.md`](production-image-and-release.md) for the build.

**This was not always the case.** The board shipped with OpenWrt **15.05 (Chaos Calmer,
kernel 3.18, 2015)**, frozen with no security updates — an old OpenSSL, and a Dropbear
SSH so old that modern OpenSSH clients reject its key exchange without
`-oKexAlgorithms=+diffie-hellman-group1-sha1`. That is what the uplift fixed; a board
still on the factory image behaves as described above until it is flashed.
([`openwrt-incremental-upgrade.md`](openwrt-incremental-upgrade.md),
[`gaps-and-risks.md`](gaps-and-risks.md) "OpenWrt upstream uplift")

### Two layers of "OpenWrt" repos

- `openwrt-tessel` is the **overlay / wrapper** — it adds Tessel-specific packages (`node`, `tessel-tools`, `tessel-app`, `tessel-mdns`), board target config, and files.
- `openwrt` is the **actual OpenWrt source tree** (kernel, BusyBox, build system), included as a submodule of `openwrt-tessel`.

On Windows these two are deliberately *not* checked out (`update = none` in [`.gitmodules`](../.gitmodules)); the containerised build under [`build/openwrt-incremental/`](../build/openwrt-incremental/) fetches its own OpenWrt sources inside a Linux container instead. ([`README.md`](../README.md) "Working with this repo")

---

## 3. Yes — there is a real Node.js binary on the board

The Tessel doesn't run a special "Tessel-flavored JavaScript." It runs **stock Node.js**, compiled for the board's CPU and packaged as an OpenWrt package.

> **On the 25.12 production image the packaging differs**, though the conclusion below
> is unchanged: it is still a stock Node 8.11.3 built from the official source tarball,
> but it is cross-compiled in an in-ladder OpenWrt **19.07** toolchain and then lifted
> onto 25.12 under `/opt/tessel`, with `/usr/bin/node` becoming a wrapper that sets
> `LD_LIBRARY_PATH` and `NODE_PATH`. The `openwrt-tessel` package recipe quoted below is
> the original in-tree packaging and is still the clearest statement of *what* is built
> and with which flags. See [`architecture.md`](architecture.md) "Layout on the 25.12
> production image" and
> [`production-image-and-release.md`](production-image-and-release.md) for why.

### The Node package definition

[`openwrt-tessel/package/node/node/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/node/node/Makefile) is an OpenWrt package recipe that downloads Node's official source tarball and cross-compiles it:

```makefile
PKG_NAME:=node
PKG_VERSION:=v8.11.3
PKG_SOURCE:=node-$(PKG_VERSION).tar.xz
PKG_SOURCE_URL:=https://nodejs.org/dist/${PKG_VERSION}/   # ← literally nodejs.org
...
define Package/node/install
	mkdir -p $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/out/Release/node $(1)/usr/bin/node   # ← installed at /usr/bin/node
endef
```

So `/usr/bin/node` is a real Node runtime built from `node-v8.11.3.tar.xz` off nodejs.org. The CLI confirms this by literally running `node --version` on the board. ([`t2-cli/lib/tessel/version.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/version.js) lines 13–23)

### It's a *constrained* Node build

The same Makefile shows Node configured to survive on a tiny router SoC:

```makefile
CONFIGURE_ARGS = \
	--dest-cpu=$(DEST_CPU) --dest-os=linux \
	--without-snapshot --shared-zlib --shared-openssl \
	--v8-options="--max_old_space_size=20 --initial_old_space_size=4 \
	              --max_semi_space_size=2 --optimize_for_size" \
	--without-inspector --without-dtrace --without-intl

ifeq ($(ARCH),mipsel)
	CONFIGURE_ARGS += \
	 --with-mips-arch-variant=r2 \
	 --with-mips-fpu-mode=fp32 \
	 --with-mips-float-abi=soft   # ← soft-float MIPS
endif
```

What each flag tells us:
- **`--with-mips-float-abi=soft`** — the MT7620 is a **soft-float** MIPS32 chip; floating-point math is emulated in software. This is *the* reason modern Node can't be built for it: newer V8 dropped reliable soft-float MIPS support, so **8.11.3 is the last Node version that successfully cross-compiled** for this target. ([`gaps-and-risks.md`](gaps-and-risks.md) "Node.js version on device")
- **`--v8-options="--max_old_space_size=20 ..."`** — V8's heap is capped at roughly **20 MB**. Your script plus everything it allocates lives in that budget.
- **`--without-inspector`** — no Chrome DevTools / `--inspect` debugging on-device.
- **`--without-intl`** — no full ICU, so `Intl` (locale-aware dates/numbers/collation) is absent or English-only.
- **`--optimize_for_size`** — built to be small, not fast.

The npm client is also packaged and symlinked to `/usr/bin/npm`, but on-device npm is rarely how you install things — the deploy model (§5) bundles dependencies from the host instead. ([`openwrt-tessel/package/node/node/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/node/node/Makefile) lines 104–108)

### Why the version matters

Because the board is stuck at **Node 8.11.3 (EOL)**:
- Module libraries written for Node 6–8 work fine.
- Anything using ES2018+ syntax (optional chaining `?.`, nullish coalescing `??`, `BigInt`, top-level await, etc.) or Node 12+ APIs **will fail on-device**.
- Your **host-side** tooling can be any modern Node (20/22); only the *scripts that run on the board* are constrained. ([`gaps-and-risks.md`](gaps-and-risks.md) "Node.js version on device")

---

## 4. How your JavaScript talks to hardware

Running JS is one thing; blinking an LED or reading a sensor is another.

### `require('tessel')` on the device

On the board, `require('tessel')` resolves to a tiny shim installed into `/usr/lib/node/`:

- [`t2-firmware/node/tessel.js`](https://github.com/aaronpowell/t2-firmware/blob/master/node/tessel.js) is just:
  ```js
  const Tessel = require('./tessel-export');
  module.exports = new Tessel();
  ```
- The real logic is [`t2-firmware/node/tessel-export.js`](https://github.com/aaronpowell/t2-firmware/blob/master/node/tessel-export.js). Both are installed to `/usr/lib/node/` by the `tessel-tools` package. ([`openwrt-tessel/package/tessel/tools/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/tessel/tools/Makefile) lines 36–38)

### The bridge: Unix domain sockets → SPI → SAMD21

`tessel-export.js` doesn't touch hardware directly. It opens **Unix domain sockets** representing the two module ports: ([`t2-firmware/node/tessel-export.js`](https://github.com/aaronpowell/t2-firmware/blob/master/node/tessel-export.js) lines 311, 694–695)
```js
this.sock = net.createConnection({ ... });   // line 311
A: '/var/run/tessel/port_a',                  // lines 694-695
B: '/var/run/tessel/port_b'
```

Those sockets are served by a C daemon, **`spid`** (the "SPI daemon"), which bridges them to the physical SPI bus connecting the MT7620 to the SAMD21. A second daemon, **`usbexecd`**, accepts commands over USB. Both are C programs built from `t2-firmware/soc/` and installed by the `tessel-tools` package. ([`openwrt-tessel/package/tessel/tools/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/tessel/tools/Makefile) lines 28–34)

```
your JS:  tessel.led[0].high()
   ↓  (byte command)
tessel-export.js → net socket → /var/run/tessel/port_a
   ↓
spid (C daemon) → SPI bus
   ↓
SAMD21 firmware (bridge.c / port.c) → toggles the actual GPIO pin
```

So the JS API is essentially a **protocol client**: high-level calls get encoded as command bytes, shipped over a socket to `spid`, forwarded over SPI, and executed by the SAMD21's real-time firmware. This layering is also *why* the Node version can stay frozen: the realtime work lives in C daemons and MCU firmware, not Node. A future OpenWrt uplift can keep `spid`/`usbexecd` and just re-slot Node. ([`gaps-and-risks.md`](gaps-and-risks.md) "OpenWrt upstream uplift")

---

## 5. What actually happens when you run `t2 run index.js`

This directly answers "could we push any npm package." The deploy is a host-side bundling step, not an on-device `npm install`.

1. **Bundle the project on the host.** `t2-cli` collects your entry file *and its `node_modules`*, optionally uglifies, and produces a tarball in memory. ([`t2-cli/lib/tessel/deployment/javascript.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deployment/javascript.js) — `tarBundle`)
2. **Create the target dir & untar over SSH/USB** using standard BusyBox commands: ([`t2-cli/lib/tessel/deploy.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deploy.js) lines 150, 338–339; [`commands.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/commands.js) lines 81–88)
   ```
   mkdir -p /tmp/remote-script/     (Tessel.REMOTE_RUN_PATH)
   tar -x -C /tmp/remote-script/    (fed the bundle on stdin)
   ```
   Paths are constants: `/tmp/remote-script/` for `t2 run`, moved to `/app/` for `t2 push` (run-on-boot). ([`t2-cli/lib/tessel/tessel.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/tessel.js) lines 136–139)
3. **Execute `node`:** ([`commands.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/commands.js) lines 48–52)
   ```js
   js: { execute(rootpath, relpath, options) {
     return flatten(['node', options.binopts, rootpath + relpath, options.subargs]);
   } }
   ```
   i.e. `node /tmp/remote-script/index.js`. For `t2 push`, a `/app/start` script does `exec node /app/remote-script/<entry>`.

So "pushing an npm package" means: **the package's files get tarred up with your app on your PC and extracted onto the board's filesystem, then run by the on-device Node 8.** There's no compilation on the board.

### The native-module catch (the real limit on "any npm package")

Pure-JS packages ship as-is and just work (subject to Node 8 syntax). Packages with **native C/C++ addons** (`.node` binaries via `node-gyp`/`binding.gyp`) are different, and the CLI has an entire subsystem for them:

- It scans the bundle for native modules: ([`javascript.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deployment/javascript.js) line 121)
  ```js
  var patterns = ['node_modules/**/*.node', 'node_modules/**/binding.gyp'];
  ```
- For each, it fetches a **precompiled MIPS/OpenWrt binary** from a binary server and swaps it in for your host machine's build (`resolveBinaryModules` / `injectBinaryModules`). The server base URL is configurable. ([`t2-cli/lib/remote.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/remote.js) line 36 `PACKAGES_BASE_URL`)
- If no precompiled binary exists, you get this warning and the deploy is effectively broken for that dependency: ([`javascript.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deployment/javascript.js) lines 90–104)
  > *"Pre-compiled module is missing… 3. The binary may be platform specific and impossible to compile for OpenWRT."*

**Why can't it just compile on the board?** Native addons need `node-gyp`, Python, a C/C++ toolchain, and headers — none of which realistically fit or run on a 4 MB-image, 20 MB-heap router SoC. So Tessel's model is "precompile the popular ones on a server, download the matching binary at deploy time." A module marked `"tessel": { "skipBinary": true }` in its `package.json` can opt out if it doesn't truly need the `.node`. ([`javascript.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deployment/javascript.js) line 139)

### So: which npm packages can you push?

| Package type | Works on-device? | Why |
|---|---|---|
| Pure JavaScript, Node 6–8 compatible | ✅ Yes | Bundled and run directly; the official Tessel module libs are all this. ([`repos.md`](repos.md) module table) |
| Pure JS but using ES2018+/Node 12+ features | ❌ No | Device Node is 8.11.3 (EOL). |
| Native addon **with** a precompiled MIPS binary on the package server | ✅ Yes | CLI downloads & injects the OpenWrt binary. |
| Native addon **without** a precompiled binary | ❌ No | "impossible to compile for OpenWRT" warning; nothing to run on MIPS. |
| Anything memory-hungry | ⚠️ Risky | ~20 MB V8 heap ceiling. |

> ⚠️ **Caveat for this fork:** the precompiled-binary server (`PACKAGES_BASE_URL` → GitHub Releases `/binaries`) is not populated. Firmware images *are* published — see [Releases](https://github.com/aaronpowell/tessel-2-revive/releases) and [`production-image-and-release.md`](production-image-and-release.md) — but per-package MIPS binaries are not. So native modules will fail to resolve unless you point `T2_PACKAGES_BASE_URL` at a source that has them or supply the binary yourself. Pure-JS packages are unaffected.

---

## 6. Two ways the host reaches the board (USB vs LAN)

`t2-cli` abstracts two transports behind a common `Connection` interface:

- **USB** — frames go to the SAMD21's USB bridge, which relays over SPI to the SoC. Handled by [`t2-cli/lib/usb-connection.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/usb-connection.js) on the host and `usbexecd` on the device. Works with zero prior network setup — this is how you *first* provision a board.
- **LAN/SSH** — once WiFi/Ethernet is configured, the CLI just SSHes in. Handled by [`t2-cli/lib/lan-connection.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/lan-connection.js).

On Windows the USB device (`1209:7551`) may need a WinUSB/libusbK driver via Zadig, and to use it from WSL2 you attach it with `usbipd`. ([`gaps-and-risks.md`](gaps-and-risks.md) "Windows native USB driver"; [`getting-started.md`](getting-started.md) step 2)

---

## 7. Putting it all together

```
Your PC (Node 20+, any OS)                    Tessel 2 board
─────────────────────────                     ─────────────────────────────────
t2-cli
  • bundles index.js + node_modules → tar
  • swaps native .node for MIPS binaries
       │  USB (usbexecd)  or  SSH/LAN
       ▼
                                    mkdir -p /tmp/remote-script
                                    tar -x -C /tmp/remote-script
                                    node /tmp/remote-script/index.js
                                          │  (real Node.js v8.11.3, MIPS)
                                          ▼
                                    require('tessel') → /usr/lib/node/tessel-export.js
                                          │  net socket
                                          ▼
                                    /var/run/tessel/port_a  ← served by spid (C)
                                          │  SPI bus
                                          ▼
                                    SAMD21 firmware → real GPIO/I2C/SPI/UART/ADC
```

**The one-paragraph version:** OpenWrt *is* a real (if tiny and old) Linux distro on a router-class MIPS chip. The device runs a genuine, unmodified-source Node.js v8.11.3 binary cross-compiled for that chip. `t2 run` tars your project — including its `node_modules` — on your PC, ships it to the board over USB or SSH, and runs `node` on it. Any pure-JS package that fits inside Node 8's language/API surface and the ~20 MB heap will run; native-addon packages only run if a precompiled MIPS binary is available, because you can't compile C on the board. Hardware access is a thin JS shim that pipes commands over a Unix socket to a C daemon (`spid`) and across SPI to the SAMD21 microcontroller, which does the actual real-time pin work.

---

## Sources

### Local (this repo & submodules)
- Architecture, processes, SPI bridge, deploy walkthrough — [`architecture.md`](architecture.md)
- Repo inventory, OpenWrt age/target, module list — [`repos.md`](repos.md)
- Node version constraint, native-module reality, SSH/OpenWrt-uplift risks, unpublished binaries — [`gaps-and-risks.md`](gaps-and-risks.md)
- Flash/run walkthrough, expected versions, hello-world — [`getting-started.md`](getting-started.md)
- **Node.js OpenWrt package (v8.11.3, soft-float MIPS, 20 MB heap)** — [`repos/openwrt-tessel/package/node/node/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/node/node/Makefile)
- **tessel-tools package (installs spid, usbexecd, tessel.js, tessel-export.js)** — [`repos/openwrt-tessel/package/tessel/tools/Makefile`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/tessel/tools/Makefile)
- Run-on-boot procd init — [`repos/openwrt-tessel/package/tessel/tessel-app/files/tessel-app.init`](https://github.com/aaronpowell/openwrt-tessel/blob/master/package/tessel/tessel-app/files/tessel-app.init)
- JS hardware shim & port sockets — [`repos/t2-firmware/node/tessel.js`](https://github.com/aaronpowell/t2-firmware/blob/master/node/tessel.js), [`repos/t2-firmware/node/tessel-export.js`](https://github.com/aaronpowell/t2-firmware/blob/master/node/tessel-export.js)
- Deploy/bundle & native-module handling — [`repos/t2-cli/lib/tessel/deployment/javascript.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deployment/javascript.js), [`repos/t2-cli/lib/tessel/deploy.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/deploy.js), [`repos/t2-cli/lib/tessel/commands.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/commands.js), [`repos/t2-cli/lib/tessel/tessel.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/tessel.js)
- Binary/artifact URLs — [`repos/t2-cli/lib/remote.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/remote.js)
- On-device Node version probe — [`repos/t2-cli/lib/tessel/version.js`](https://github.com/aaronpowell/t2-cli/blob/master/lib/tessel/version.js)

### Upstream / external
- Tessel 2 Technical Overview — https://tessel.gitbooks.io/t2-docs/content/Debugging/Technical_Overview.html
- Tessel 2 Hardware Overview — https://tessel.gitbooks.io/t2-docs/content/Hardware/Tessel_2_Overview.html
- OpenWrt project — https://openwrt.org
- OpenWrt ramips/MT7620 Tessel target — https://openwrt.org/toh/hwdata/tessel/tessel_tessel_2
- Node.js native addons — https://nodejs.org/api/addons.html
- Node.js v8.11.3 source — https://nodejs.org/dist/v8.11.3/
