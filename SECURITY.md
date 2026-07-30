# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
([Security → Report a vulnerability](https://github.com/aaronpowell/tessel-2-revive/security/advisories/new)),
or contact [@aaronpowell](https://github.com/aaronpowell) directly.

This is a hobby project maintained in spare time. There is no SLA. I'll
acknowledge reports when I see them and fix what I reasonably can.

## What is and isn't in scope

**In scope** — anything in this repository's own work:

- The build configuration under `build/openwrt-incremental/` producing an image with
  a weaker posture than intended (e.g. an unintended service listening, a bad default
  in the first-boot `uci-defaults` scripts).
- The published release artifacts not matching what this repository builds.
- The `t2 update` / `t2 restore` distribution path.
- The scripts in `tools/`.

**Out of scope:**

- Vulnerabilities in **upstream OpenWrt, the Linux kernel, BusyBox, musl, dropbear,
  U-Boot or Node.js**. Report those upstream. This project tracks a current OpenWrt
  release specifically so that upstream fixes arrive by upgrading.
- **Node.js 8.11.3**, which the device runs. It is years past end-of-life and is
  known-vulnerable. See below.
- Physical access to the board. Anyone holding a Tessel 2 owns it — USB DFU and the
  serial console are unauthenticated by design.

## Known and accepted posture

Be realistic about what this device is. It is a 2015 development board with 64 MB of
RAM being kept alive as a hobby, not a hardened appliance.

- **The on-device Node.js is 8.11.3, EOL since December 2019.** Newer V8 will not run
  on this hardware in any practical way. If you run untrusted JavaScript on a Tessel,
  you should assume it can compromise the board.
- **`root` has no password set by default.** Verified on a production r5 board:
  `/etc/shadow` reads `root:::0:99999:7:::`. That is stock OpenWrt behaviour and is
  what makes first-boot access and `t2 provision` work. Set one if the board is
  anywhere you don't control.
- **`t2 provision` installs an SSH key** to `/etc/dropbear/authorized_keys` from
  `~/.tessel/id_rsa`. Anyone with that key has root on the board.
- **WiFi credentials are stored in plaintext** in `/etc/config/wireless`, as on any
  OpenWrt device.
- **Diagnostic images are deliberately weak.** Images built with `TESSEL_DIAG=1` bring
  up an open-to-the-world debugging posture on purpose: a `Tessel-Diag` access point
  with the published passphrase `tesseldiag`, and the same string set as the `root`
  password so SSH is deterministic. Both values are in this repository. They exist so
  an otherwise-unreachable board can be debugged, and are **not** present in
  production images. Never leave a DIAG image on a board you care about.
- **Release artifacts are not signed, and checksums are not currently published**
  alongside them. The build tooling computes SHA-256 for both tarballs
  (`build/openwrt-incremental/scripts/make-release-artifacts.sh` prints them) but the
  release notes don't yet record them. Until they do, your only real assurance is that
  you downloaded over HTTPS from GitHub Releases. This is a known gap.

[`docs/security-threat-assessment.md`](docs/security-threat-assessment.md) is a fuller
assessment written to justify doing the OpenWrt uplift in the first place — it covers
what network isolation does and does not mitigate for a device like this.

## Recommendation

Treat a Tessel 2 as an untrusted device on your network. Put it on a guest or IoT
VLAN, don't expose it to the internet, and don't give it credentials you care about.

Keeping the board on the latest release is the single most useful thing you can do —
that is what pulls in upstream OpenWrt security fixes:

```bash
t2 update       # USB only
```
