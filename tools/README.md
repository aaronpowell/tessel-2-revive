# `tools/` — hardware probe scripts

Two small scripts for running a shell command on a Tessel 2 and reading the output
back. They exist because `t2-cli` has no general "run this command on the board"
verb, which makes hardware validation awkward:

- **`t2 root` and `t2 ssh` are LAN-only.** A board that has not joined a network yet
  — the state it is in immediately after `t2 restore` — cannot be reached by either.
  `usb-exec.js` is the only way to get a shell on it.
- `t2 run` executes a *JavaScript* file, so using it to inspect the OS means writing
  a throwaway script that shells out, on a board whose Node is 8.11.3.

Both scripts reuse `t2-cli`'s own transports, so they authenticate and frame exactly
the way the CLI does rather than reimplementing it.

## Prerequisites

The `repos/t2-cli` submodule must be checked out and its dependencies installed:

```bash
git submodule update --init repos/t2-cli
cd repos/t2-cli && npm install
```

Set `T2_CLI_DIR` to point at a different `t2-cli` checkout if you do not want to use
the bundled submodule.

## `usb-exec.js` — over USB

```bash
node tools/usb-exec.js "uci show wireless"
```

Requires the board to be plugged in over USB. No provisioning, no network, and no SSH
key needed — it speaks the SAMD21 USB bridge protocol.

Times out after 45 s with exit code 3 if no board responds.

## `lan-exec.js` — over LAN/SSH

```bash
node tools/lan-exec.js 192.168.1.176 "cat /etc/tessel-release"
node tools/lan-exec.js tessel-lab-bench.local "logread | tail -50"
```

Requires the board to be on the network and provisioned (`t2 provision` over USB),
because it authenticates with the key at `~/.tessel/id_rsa`.

## Gotchas

- **`usb-exec.js` does not give you a usable exit code.** The USB transport's `close`
  event reports `true` rather than the remote command's status, so the trailing
  `--- exit ... ---` line is not a shell exit code. Assert on the *output*, not on
  the status. `lan-exec.js` streams output but likewise always exits 0.
- **`OPEN ERROR: Not connected` from `lan-exec.js` is usually a transient WiFi blip.**
  Retry once before concluding anything is broken.
- **`OPEN ERROR: LIBUSB_ERROR_ACCESS` from `usb-exec.js` means another process holds
  the device**, not that your driver or permissions are wrong. Only one process can
  claim the Tessel over USB at a time, so two people (or two agent sessions) cannot
  probe concurrently. Confirm the hardware is fine with
  `Get-PnpDevice -PresentOnly | Where-Object InstanceId -like "*VID_1209*PID_7551*"` —
  if the composite device and its three interfaces are all `Status: OK`, it is
  contention. Then look for a stray `tessel-2.js` process and kill it by PID; several
  `t2` subcommands do not reliably exit and keep the handle open long after they
  appear finished.
- **The device is busybox, not coreutils.** `hostname` is not present, for example —
  read `/proc/sys/kernel/hostname` or `uci get system.@system[0].hostname` instead.
  Check that a command exists before treating its absence as a finding.
- Quote the whole command as a single argument. Both scripts join `argv` with spaces
  and hand the result to `/bin/sh -c`, so shell metacharacters are interpreted **on
  the board** — but your local shell gets first pass at them.

## Verified

Both scripts were run against a board on release `v25.12.5-node8-r5`
(`/etc/tessel-version` = `ab51d6a`, OpenWrt 25.12.5, kernel 6.12.94, Node 8.11.3).
