# Contributing

Issues and pull requests are both open. This is a working project — if you have a
Tessel 2 in a drawer and something here doesn't work for you, that's worth an issue.

There is no CLA, no style checklist, and no expectation that you finish what you
start. A well-evidenced bug report is as valuable as a patch.

## The one rule: bring evidence

Almost everything in this project is hardware behaviour, and hardware behaviour is
easy to describe plausibly and wrongly. Several conclusions in this repo's history
were confidently reached, written down, and later found to be false — see
[`docs/gaps-and-risks.md`](docs/gaps-and-risks.md).

So for anything involving a board, please include:

- **Board revision** — printed on the board itself.
- **`cat /etc/tessel-release`** — release, build date, git commit, OpenWrt and kernel
  versions, node version. If the file doesn't exist, the board predates `r1`; say so.
- **`cat /etc/tessel-version`** — the sha the update feed matches on.
- **How you flashed it** — `t2 restore`, `t2 update`, a raw `.bin`, or it came that way.
- **Transport** — USB or LAN, and which `t2` command you ran verbatim.
- **The actual output**, not a summary of it.

The issue templates ask for these.

## Before you file a bug

A few behaviours look like faults and aren't. Please check
[`docs/getting-started.md`](docs/getting-started.md) first, and specifically:

- `t2 list` **never exits.** That's by design; it scans until interrupted.
- `t2 list` writes to **stderr**, not stdout.
- `LIBUSB_TRANSFER_STALL` for up to a minute after replugging is **the board booting**.
- `No Authorized Tessels Found` on the first attempt, succeeding on the second or
  third, is a known discovery race. Retry two or three times before reporting.
- `t2 update` requires **USB**; it refuses over LAN.
- `t2 restore` does **not** reboot the board — unplug and replug, then wait ~3 minutes.

If it still fails after that, it's a real bug and we'd like to know.

## Pull requests

- Branch from `main`.
- Keep commits logical; a readable history matters more here than a tidy one.
- **Don't rewrite published history**, and don't force-push shared branches.
- Say what you tested it on. "Built successfully" is not the same as "flashed to an
  r5 board and power-cycled" — please be explicit about which one you did.

### Changes to the OpenWrt image

Read [`.github/skills/tessel-openwrt-build/SKILL.md`](.github/skills/tessel-openwrt-build/SKILL.md)
first. It documents the traps that cost the most time here — chiefly that kernel
config symbols must be injected into the *kernel config fragment* (a seed entry is
silently dropped by `make defconfig`), and that the DTS firmware partition must stay
bare or the board will not boot.

Image changes need a hardware gate, not just a successful build. If you can't flash
it, say so in the PR — that's fine, someone else can gate it.

### Changes to `repos/*`

Those are git submodules pointing at separate forked repositories. Open the PR
against the fork itself; the pointer bump in this repo comes after.

### Changes to documentation

Please verify claims against the code, the git history, or `gh` before asserting
them. If you're correcting something that's wrong, correcting it in place is better
than adding a caveat next to it.

## Licensing

Contributions to this repository's own work are accepted under the **MIT** licence.
Contributions to anything under `build/openwrt-incremental/overlay/` — kernel
patches, the board DTS, OpenWrt package content — are **GPL-2.0**, because those are
derivative works of Linux and OpenWrt. [`NOTICE`](NOTICE) has the breakdown.

## Security

Please don't file security issues as public issues. See
[`SECURITY.md`](SECURITY.md).
