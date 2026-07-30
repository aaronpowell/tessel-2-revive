---
name: tessel-hardware-validation
description: Use when talking to a Tessel 2 board from a dev box — running t2-cli commands, reading state off the device, provisioning, flashing, or gating a change on real hardware. Covers the t2-cli commands that hang, reject flags, or fail spuriously, and the tools/usb-exec.js and tools/lan-exec.js probes that fill the gap where t2-cli cannot run a shell command. Trigger on "t2 list", "t2 provision", "t2 update", "t2 restore", "t2 run", "check the board", "read something off the device", "validate on hardware", "LIBUSB_TRANSFER_STALL", "No Authorized Tessels Found".
---

# Talking to a Tessel 2 from a dev box

The happy path is in [`docs/getting-started.md`](../../../docs/getting-started.md). This
skill is the set of behaviours that waste time because they look like failures and are
not — every one of them cost real debugging effort here.

## Getting a shell on the board

`t2-cli` has **no general "run this command on the board" verb**, and `t2 root` / `t2 ssh`
are **LAN-only**. A board that has not joined a network — the state it is in right after
`t2 restore` — cannot be reached by either. Use the repo's probes:

```bash
node tools/usb-exec.js "cat /etc/tessel-release"        # USB; no network, no provisioning needed
node tools/lan-exec.js <host-or-ip> "logread | tail -50" # LAN; needs ~/.tessel/id_rsa
```

Both need `repos/t2-cli` checked out with `npm install` run in it. See
[`tools/README.md`](../../../tools/README.md).

Do **not** try to inspect the OS by writing a throwaway `t2 run` script — you would be
shelling out from a Node 8.11.3 process on a busybox system to do what a one-line probe
does directly.

## Commands that behave badly

| Symptom | What is actually happening |
|---|---|
| `t2 list` never returns | It scans forever by design. Fine interactively; it will hang any script or agent. Start it in the background, sleep ~15 s, read its output, then kill it **by the literal PID you captured**. |
| `t2 list` prints nothing to stdout | Its output goes to **stderr**. Capture with `2>&1`. |
| `t2 provision --usb` → `'--usb' expects a value` | `t2 provision` has no `--usb` flag; it is USB-only by definition. The global flag parser tries to consume the next argument. Just run `t2 provision`. |
| `t2 update --lan` aborts | `Must have Tessel connected over USB to complete update.` Updates are USB-only regardless of transport availability. |
| `LIBUSB_TRANSFER_STALL`, up to ~1 min after replugging | The board is **booting**. Not a bad flash. Wait it out before re-flashing anything. |
| `LIBUSB_ERROR_ACCESS` | **Another process holds the device.** This is not a driver or permissions problem and Zadig will not help — see below. |
| `No Authorized Tessels Found` on the first attempt, then success | Discovery races the authorisation probe. Retry two or three times, unchanged, before investigating. Frequently preceded by `WARN Detected a Tessel that may be booting.` |
| `OPEN ERROR: Not connected` from `lan-exec.js` | Transient WiFi blip. Retry once. |
| `Invalid status code on build server request: 404` | The `t2 update` feed at `raw.githubusercontent.com/<repo>/main/releases/builds.json` is unreachable — most likely the repo is private, or the branch/path is wrong. |
| `t2 restore` finishes but the board does nothing | `t2 restore` **does not reboot the board.** Unplug and replug physically. First boot then takes ~3 minutes while it formats the jffs2 overlay and runs first-boot scripts. |

Because several of these are timing-dependent, **a single failing run is not evidence.**
Repeat before concluding.

## Only one process can hold the USB device

`LIBUSB_ERROR_ACCESS` reads like a driver or permissions fault and sends people to Zadig.
It usually isn't. **It means something else already has the device claimed.**

Check the device is genuinely healthy first:

```powershell
Get-PnpDevice -PresentOnly | Where-Object InstanceId -like "*VID_1209*PID_7551*"
```

If the composite device and its three `MI_00/01/02` interfaces all report `Status: OK`,
the hardware and driver are fine and the problem is contention. Find the holder:

```powershell
Get-Process node | Select-Object Id,StartTime,@{n='cmd';e={
  (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine}}
```

Look for a `tessel-2.js` process — **including one that should have exited.** This was
observed with a `node bin\tessel-2.js version` still alive 28 minutes after it was run,
silently holding the handle. Several `t2` subcommands do not reliably exit; `t2 list`
never does by design, and others can hang the same way. Kill it by its literal PID and
retry.

Two consequences worth internalising:

- **Two people, sessions or agents cannot probe USB at the same time.** The second gets
  `LIBUSB_ERROR_ACCESS`. Coordinate before assuming the tooling is broken.
- **A leftover process from an earlier run is the default suspect.** This is the same
  failure shape as a stale HTTP server still bound to a port — the environment held
  state you assumed was clean. Check before blaming the code.

Prove it rather than guessing: reproduce the error with the suspected holder alive, kill
it, and confirm the same command now succeeds. If it doesn't flip, contention wasn't the
cause.

`Get-PnpDevice` without `-PresentOnly` also lists **ghost entries** from earlier
enumerations, showing `Status: Unknown` with different instance-path suffixes. They are
harmless leftovers, but they make it look like several boards are attached. Always pass
`-PresentOnly` when you want the truth.

## Reading device state

```bash
cat /etc/tessel-version    # the git sha the image was built from; what the update feed matches on
cat /etc/tessel-release    # RELEASE=, BUILD_DATE=, GIT_COMMIT=, OPENWRT_VERSION=, KERNEL_VERSION=, NODE_VERSION=
uname -r                   # kernel
node -e "console.log(process.version)"
```

The device is **busybox, not coreutils**. `hostname` does not exist — read
`/proc/sys/kernel/hostname` or `uci get system.@system[0].hostname`. Before treating a
missing command as a finding, check whether it exists at all.

Neither probe gives you a usable exit status (`usb-exec.js` reports the transport's
`close` value, not the shell's), so **assert on output, never on the exit code**.

## Gating a change on hardware

- **Flash it, don't just build it.** An image that compiles proves nothing about a
  device that boots.
- **Match the gate to the claim.** A config-preservation fix must be gated with a real
  `t2 update` on a board that *has* user config. A clean flash has no config to lose, so
  it structurally cannot detect a clobber.
- **Prove guards in both directions.** "The config survived" cannot distinguish a working
  guard from one that never fired. Show it preserves a real value *and* still seeds an
  unconfigured one.
- **Power-cycle before believing it.** Live-patched state disappears; a clean flash plus a
  power cycle is the real gate.
- **Hash what was actually served, not the file on disk.** See the
  `hardware-debugging-traps` skill.

A worked example of a full gate — OS, runtime, and LED checks with the exact expected
values — is in
[`docs/production-image-and-release.md`](../../../docs/production-image-and-release.md) §4.
