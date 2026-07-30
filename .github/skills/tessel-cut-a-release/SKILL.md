---
name: tessel-cut-a-release
description: Use when publishing a Tessel 2 firmware release — building the production image, producing tessel-restore.tar.gz and tessel-update.tar.gz, creating the GitHub release, and updating the releases/builds.json update feed that t2 update reads. Covers the asset names and version strings that are load-bearing, and why the published bytes must be verified by downloading them back. Trigger on "cut a release", "publish firmware", "builds.json", "update feed", "tessel-restore.tar.gz", "tessel-update.tar.gz", "gh release create", "t2 update", "t2 restore".
---

# Cutting a Tessel 2 firmware release

> **Verified: July 2026**, cutting `v25.12.5-node8-r5` with `t2-cli` at `2296f56`.
> The URL and filename rules below are read out of `t2-cli`'s source — if the CLI
> changes, they change. Re-check `repos/t2-cli/lib/remote.js` before trusting them.

The runbook is [`docs/production-image-and-release.md`](../../../docs/production-image-and-release.md)
**§6** — follow it. This skill is the set of details that are load-bearing and easy to get
subtly wrong.

## Asset names are part of the API

`t2-cli` hardcodes the URLs it fetches (`repos/t2-cli/lib/remote.js`):

- `t2 restore` defaults to
  `https://github.com/<repo>/releases/latest/download/tessel-restore.tar.gz`
- the update feed is
  `https://raw.githubusercontent.com/<repo>/main/releases/builds.json`

So **the release asset must literally be named `tessel-restore.tar.gz`**, and it must be
attached to the release GitHub considers *latest*. r1 and r2 shipped
`new_build_<...>.tar.gz` and `t2 restore` simply could not find them; that was only fixed
at r4.

The two tarballs are different formats and are not interchangeable:

| Asset | Consumed by | Members |
|---|---|---|
| `tessel-restore.tar.gz` | `t2 restore` (USB/DFU full recovery) | u-boot + squashfs |
| `tessel-update.tar.gz` | `t2 update` | `openwrt.bin` (+ optional `firmware.bin`) |

Build both with `build/openwrt-incremental/scripts/make-release-artifacts.sh`, which exists
precisely so the member names and output names cannot drift.

## Version strings

- **`gh release create --target` needs the full 40-character sha.** A short sha returns
  HTTP 422.
- **Feed `version` must be a valid semver prerelease with a dotted-numeric identifier**:
  `25.12.5-r.5`, **not** `25.12.5-r5`. `t2-cli` compares these with `semver.gte`, and
  `-r5` does not parse the way you want.
- **Feed `sha` must equal the trimmed contents of `/etc/tessel-version` exactly.** That is
  the only key the CLI matches a running board on. Read it off a real board rather than
  assuming it matches the tag.

Feed entry shape (`releases/builds.json`):

```json
{
  "version": "25.12.5-r.5",
  "released": "2026-07-30T00:05:56.000Z",
  "sha": "ab51d6a",
  "tag": "v25.12.5-node8-r5",
  "archiveUrl": "https://github.com/<repo>/releases/download/<tag>/tessel-update.tar.gz"
}
```

## What a missing feed entry actually costs

A board whose sha is **not** in the feed does not crash. `findBuild`
(`lib/update-fetch.js`) is a plain `.find()` returning `undefined`, `lib/controller.js`
guards the deref, and it logs *"Could not match the build running on X to a known release;
updating anyway"* and proceeds.

So the cost of a missing entry is **the version comparison** — the "you are already on the
latest" check — not correctness.

That is why **r1 and r2 are deliberately absent** from the feed: their only asset is a
*restore* bundle, not the update format. Adding entries for them would make
`t2 update --version 25.12.5-r.1` download a restore bundle and fail confusingly. Absent
is better than wrong.

(There is no r3. It was built and superseded by r4 before release. Do not go looking for it
and do not renumber to fill the gap.)

## Verify the published bytes, not the local ones

After publishing, **download the assets back** and hash what you receive. Do not hash the
file you uploaded from.

The reason is not paranoia: on this project an image was nearly "gated" against a stale
tarball because a local HTTP server from an earlier run was still bound to the port and
still serving old bytes. The local file was correct; what was served was not. Only hashing
the *retrieved* bytes catches that class of error.

### Required: check the distribution URLs from a logged-out context

`gh` and a browser you are signed into will happily return `200` for content that is
`404` for everyone else. `t2-cli` fetches these **unauthenticated**, so authenticated
checks prove nothing about whether the release actually works.

Run this with **no `gh` auth and no cookies** — a plain `curl`, or a private window:

```bash
curl -sS  -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/aaronpowell/tessel-2-revive/main/releases/builds.json

curl -sSL -o /dev/null -w '%{http_code}\n' \
  https://github.com/aaronpowell/tessel-2-revive/releases/latest/download/tessel-restore.tar.gz
```

**Both must print `200`.** The second needs `-L` because the release download redirects
to object storage.

A `404` here means `t2 update` and `t2 restore` are broken for every user even though
everything looked correct while you were signed in. Causes worth checking, in order: the
repository is private; the release is a draft, or is not the one GitHub considers
*latest*; the asset name drifted from `tessel-restore.tar.gz`; the feed is on a branch
other than `main` or not at `releases/builds.json`.

Finally, close the loop on hardware: run an actual `t2 update` (USB — it refuses over LAN)
from the previous release to the new one and confirm the board comes up on the new
`/etc/tessel-version` **with its config intact**.
