---
name: hardware-debugging-traps
description: Use when validating a fix, gating a change, claiming something has been proven, or writing down a technical claim that others will trust later — especially against embedded devices, firmware, flashing workflows, or anything where the act of testing can destroy the evidence. A checklist for designing measurements that can actually fail, and for the specific ways a passing test can be measuring nothing at all. Trigger on "verify the fix", "prove it works", "gate this change", "the test passed but", "how do I confirm", "it worked on my machine", "is this still true", or before asserting that a change has been validated.
---

# Measurements that cannot fail prove nothing

Every trap below is a real one from this project, where a plausible, carefully-run
verification produced a confident conclusion that was wrong. They generalise well beyond
embedded work.

## The one question to ask

> **Could this measurement still look exactly like this if my hypothesis were false?**

If yes, it is not evidence. Design a different measurement before spending any more time.

The corollary: **a test that has never failed has never been shown to work.** Before you
trust a check, make it fail on purpose — break the thing it is supposed to catch and
confirm it goes red. An assertion that passes against both the fixed and the broken build
is measuring something else.

## Trap 1 — measuring after the evidence was destroyed

A conclusion here was "proven" by comparing a file on the device against `/rom` **after** a
`sysupgrade`. But sysupgrade wipes the overlay, and the overlay was where the change lived.
The comparison was taken after the only thing that could have shown the evidence had
already been erased — so it was *guaranteed* to match, fix or no fix. The real bug survived
that verification untouched.

Before running a check, ask **what your test procedure itself changes**. If the procedure
resets, reflashes, reboots, reinstalls, or reallocates the thing you are inspecting, the
measurement has to happen *before* that step, or on a different artifact entirely.

## Trap 2 — measuring the wrong copy of the artifact

An image was nearly gated against the wrong bytes: a local HTTP server from an earlier run
was **still bound to the port**, so the new server silently failed to bind and the device
downloaded a stale tarball. The file on disk was correct. What was served was not.

- Check the port is free *before* starting a server, and check the server you think you
  started is the one answering.
- Hash **what was actually delivered** — fetch it back and hash the response — not the
  local file you believe you published.
- Watch for authentication skew: a request that succeeds with your credentials may 404 for
  everyone else. Verify anonymously when the consumer is anonymous.

Generally: the artifact you validated, the artifact you shipped, and the artifact the
consumer received are three different things until you have proved otherwise.

The same shape shows up without a server anywhere in sight: a `t2` process that had
apparently finished was still holding the board's USB handle almost half an hour later,
so every probe failed with `LIBUSB_ERROR_ACCESS` — an error that reads like a driver
problem and points you at completely the wrong thing. **Before concluding the code is
broken, check whether the environment is still holding state from an earlier run.**
Ports, device handles, background processes, caches and mounted paths all persist longer
than you expect.

And when you think you've found the holder, prove it: reproduce the failure with the
suspect alive, remove it, and confirm the same command now succeeds. A fix that isn't
demonstrated to flip the result is a guess that happened to be followed by a success.

## Trap 3 — a gate that structurally cannot detect the failure

To test that an update **preserves user configuration**, you must run an *update* on a
device that *has* user configuration. A clean flash has no config to lose, so it cannot
detect a clobber no matter how carefully it is run. It will pass every time, including on
a build that destroys config.

Match the shape of the test to the shape of the failure. "Did it boot?" does not answer
"did it keep my data?".

## Trap 4 — one-directional proof of a conditional

For any guard, filter, or conditional, "the good case worked" is compatible with **the
guard never having executed at all**. Prove it **bidirectionally**:

- it preserves a real value that must survive, **and**
- it still applies the default in the case that is supposed to trigger it.

Only the pair distinguishes a working guard from dead code.

## Trap 5 — trusting a single run of a racy system

Discovery, enumeration, USB re-enumeration and network association are all racy. A single
failure is not a finding, and a single success is not a gate. Repeat, and note whether the
result is stable before drawing any conclusion from it.

Corollary: know your system's normal transient noise so you do not chase it. On this
project a USB stall for up to a minute after replug is *the board booting*, and the first
discovery attempt failing then succeeding is *routine* — both have been mistaken for real
faults.

## Trap 6 — validating the source instead of the product

Something that compiles is not something that boots. Something that boots is not something
that works after a power cycle. Live-patching a running device proves the patch's logic and
nothing about the build that is supposed to contain it.

Push the gate as far towards the real artifact and the real user as the cost allows: build
→ flash → power-cycle → exercise the actual feature.

## Trap 7 — a fact that was true when it was written

Every specific claim in a doc, a skill, or a comment is a measurement taken at a moment.
"OpenWrt's generic kernel config disables `CONFIG_MIPS_FP_SUPPORT`" and "an unknown sha
crashes the update path" were both true, and one of them stopped being true when someone
fixed it. A reader six months later cannot tell a durable invariant from a stale
observation unless you say which version you measured.

This trap is worse than doc rot because it is *self-confirming*: the claim sounds precise,
so nobody re-checks it, so it survives long after the thing it described changed.

Cheap mitigation, applied at write time:

- Stamp version-specific claims with what they were verified against — the release tag, the
  kernel version, the commit of the tool whose behaviour you are describing.
- Say whether the claim is an **invariant** (the MT7620 has no FPU) or a **default** (this
  release ships that symbol off). Defaults change; invariants do not.
- Prefer detection over version comparison in code. `build.sh` sniffs the tree for
  `DEVICE_DTS = $$(SOC)_` instead of testing `>= 21.02`, and that is why the check has
  survived four subsequent releases untouched.
- Where you *must* hardcode a boundary, cite the mechanism, not just the number, so the
  next reader can re-derive it.

## Trap 8 — a warning that is present but not where the mistake happens

"Is it documented?" is the wrong test. The right one is **would a reader hit this before
making the mistake?** Those come apart constantly, and only the first one is easy to check,
which is why the first one is the one people check.

A real instance from this repo: `tools/README.md` said *"times out after 45 s with exit
code 3 if no board responds"*, and fourteen lines further down, under **Gotchas**,
disclosed that a *successful* run reports the USB transport's `close` value rather than the
remote command's status. Both facts were correct and both were written down. But someone
wiring the script into a gate reads the line about exit code 3, concludes exit codes are
meaningful, asserts on the status, and ships a check that passes unconditionally — the
exact failure the Gotchas entry existed to prevent. The audit question "is the exit-code
behaviour documented?" returns yes. The reader is still wrong.

Note this is the *same* structure as the traps above, applied to prose: a check ("it's
documented") that cannot fail in the case you care about, and therefore proves nothing.

- Put the caveat at the **point of the claim**, not in a section that collects caveats.
  Sections like *Gotchas*, *Known issues* and *Notes* are where warnings go to be
  technically present.
- Ask where the reader is standing when they make the error, and put the correction
  *there*. `getting-started.md` gained its verify-the-checksum line at the one step where
  a reader handles release bytes by hand — not in a security section they will not be
  reading at that moment.
- If a fact is dangerous enough to warrant a warning, it is dangerous enough to interrupt
  the sentence that would otherwise mislead.

## Practical checklist

Before claiming something is verified:

1. What would this look like if I were wrong? If the answer is "the same", redesign it.
2. Has this check ever failed? If not, break something and make it fail.
3. Does my procedure destroy the evidence? Measure before that step.
4. Am I measuring the artifact the consumer gets, or a local copy of it?
5. Does the test have the precondition the failure needs (config present, right transport,
   right starting version)?
6. Did I prove the conditional in both directions?
7. Did I run it more than once?
8. Am I asserting on output, or on an exit code that may not mean what I think?
9. If I am writing this down: is it an invariant or a default, and did I record what
   version I measured it against?
10. Is the warning where the reader will be standing when they make the mistake, or just
    somewhere in the document?

## When you are wrong

Say so explicitly and correct the record where the wrong claim was written down. Several
docs in this repo were refreshed after exactly this — a rule stated with confidence, later
checked against the code, and found overstated. A corrected doc is worth more than a
confident one.
