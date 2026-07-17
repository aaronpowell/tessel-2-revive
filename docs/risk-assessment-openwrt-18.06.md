# Security Risk Assessment — Sitting on OpenWrt 18.06.9

**Date:** 2026-07-16
**Author:** Revival effort (security posture review)
**Question answered:** *We have walked the device forward from the 2015 factory image (15.05) to
**18.06.9**. If we stop and sit here, what residual risk have we retired, and what is still
outstanding?*

This is a **delta** on the baseline analysis in
[`security-threat-assessment.md`](./security-threat-assessment.md) (which covers *not upgrading at
all*, i.e. staying on 15.05). Read that first for the framework, deployment assumptions
(isolated / non-public / competently-managed segment), and the compensating controls in its §5 —
**all of those still apply here.** For how we got to 18.06 and what's next, see
[`openwrt-upgrade-progress.md`](./openwrt-upgrade-progress.md).

---

## 1. What actually changed (measured on the running 18.06.9 image)

Versions below were read **directly off the running device** via the USB serial console, so they
are concrete, not inferred. (The validated image is a WiFi-AP DIAG build; the production Tessel
image shares the same base OpenWrt package versions.)

| Component | 15.05 baseline | **18.06.9 (now)** | Latest stable (24.10) | Change |
|---|---|---|---|---|
| OpenWrt release | Chaos Calmer 15.05-rc2 (2015) | **18.06.9** (r8077, Jan 2021) | 24.10 | +3 major branches, ~5.5 yr newer |
| Linux kernel | 3.18 (EOL ~2017) | **4.14.206** (LTS, EOL Jan 2024) | 6.6 LTS | +~3 yr; Dirty COW & a decade of EoP fixed |
| Dropbear SSH | 2015, legacy KEX only | **2017.75** (curve25519 KEX) | current | modern KEX now offered |
| WiFi (hostapd/wpad) | 2015, pre-KRACK | **wpad-mini 2018-05-21** (post-KRACK) | modern, WPA3 | KRACK fixed; still WPA2-only |
| dnsmasq | 2.7x | **2.80-1.4** | 2.90+ | DNSpooq backported into `-1.4` (verify) |
| TLS (system) | OpenSSL 1.0.x era | **mbedTLS** (via libustream-mbedtls) | OpenSSL 3.x | solid TLS 1.2; still no TLS 1.3 |
| opkg feed | dead `http://` 15.05 mirror | **signed (usign) + still online** | signed + live | packages installable again |
| On-device Node.js | 4.2.1 live | **8.11.3** (soft-float MIPS ceiling) | 8.11.3 | ⚠️ **unchanged — still EOL** |

> The single most important change: 18.06 moved the device from a **decade-stale, dead-feed,
> pre-KRACK, legacy-crypto** baseline to a **~5-year-old, signed-live-feed, post-KRACK,
> modern-KEX, TLS-1.2-capable** one. But **18.06 is itself EOL** (last release 18.06.9, Jan 2021;
> branch retired shortly after) — so the *strategic* no-patch/compliance risks are **reduced in
> magnitude but not eliminated.**

---

## 2. Executive summary

**Overall residual risk sitting on 18.06.9 (isolated deployment): LOW — down from LOW-to-MODERATE
on 15.05.**

- The three highest-impact, hardest-to-isolate items from the 15.05 register are **materially
  improved**: the **WiFi headline (KRACK) is fixed**, **SSH crypto is modern**, and the **kernel
  is ~3 years newer and much harder** (Dirty COW class closed).
- The device can **receive package updates again** (signed, still-online 18.06 feed) — a real
  functional and supply-chain improvement over the dead 15.05 mirror.
- **What is NOT solved:** 18.06 is an **EOL branch** (no new security patches since ~2021), the
  **kernel 4.14 is itself EOL** (Jan 2024), **on-device Node stays 8.11.3 (EOL)**, and there is
  **no TLS 1.3**. So the compounding "no patch stream" meta-risk and the compliance/EOL exposure
  are **reduced but still present** — sitting on 18.06 **defers** the strategic problem, it does
  not **solve** it.
- **Bottom line:** 18.06 is a **much more defensible place to sit** than 15.05 — for a lab / bench
  / single-purpose isolated device it is a comfortable *accept* with the existing §5 controls. But
  if the goal is a **maintainable, patchable platform**, 18.06 is a waypoint, not a destination:
  the first still-supported branch is **23.05**, current is **24.10**.

---

## 3. Threat register — 18.06 delta

Same threats (T1–T10) as the 15.05 assessment; residual re-scored for 18.06.9. Deployment
assumptions unchanged (isolated, non-public, radio-off recommended).

| # | Threat | 15.05 residual | **18.06 residual** | Why it moved |
|---|--------|:--------------:|:------------------:|--------------|
| T1 | Kernel local privilege escalation | Low–Med | **Low** ↓ | k3.18 → **k4.14**; Dirty COW (CVE-2016-5195) and a decade of EoP fixed; better ASLR/hardening. (4.14 is itself EOL, so not zero.) |
| T2 | WiFi / 802.11 stack (KRACK, WPA2-only) | **Medium** | **Low–Med** ↓ | hostapd/wpad **2018-05-21 = post-KRACK** → KRACK fixed. Still **WPA2-only** (`wpad-mini`, no SAE/WPA3/PMF) and **FragAttacks (2021) unpatched**. Radio still bypasses wired isolation. |
| T3 | Outbound TLS weakness | Low–Med | **Low–Med** ≈ | System TLS via **mbedTLS** gives solid **TLS 1.2**; **no TLS 1.3**. Node 8's **bundled OpenSSL 1.0.2 (EOL)** still governs app-level HTTPS egress — unchanged. |
| T4 | Dropbear SSH legacy KEX | Low | **Low (usability fixed)** ↓ | **dropbear 2017.75** offers curve25519 → modern clients connect **without** the `-oKexAlgorithms=+diffie-hellman-group1-sha1` workaround. Security + usability both improved. |
| T5 | dnsmasq DNSpooq / mDNS | Low | **Low** ↓ (verify) | **dnsmasq 2.80-1.4** — 18.06.9 (Jan 2021) was the DNSpooq release; fixes were backported into the `-1.4` package. Confirm the backport before formal sign-off. |
| T6 | Supply chain / no updates | Low (feed dead ⇒ frozen) | **Low (feed live + signed)** ↕ | 18.06 feed is **signed (usign) and still online** → device can install/update **within** 18.06. Improvement in capability; but the **branch itself is frozen** (no new point releases). |
| T7 | EOL app runtimes (Node) | **Med** | **Med** ✗ **unchanged** | **Node stays 8.11.3 (EOL 2020).** No OpenWrt hop changes this — soft-float MIPS caps V8. Any app parsing untrusted input still runs on an EOL interpreter. |
| T8 | No security patch stream (meta) | **Med** | **Med (reduced magnitude)** ↕ | Gap shrank **~11 yr → ~5.5 yr** and the base is far less scary, but **18.06 is EOL** → still no new patches. The compounding risk is deferred, not removed. |
| T9 | Physical / USB / serial | Low–Med | **Low–Med (better understood)** ≈ | Unchanged in exposure. Note: this effort **confirmed a USB serial-console root shell on any image** — a diagnostic win, but also a reminder that **physical USB access = full compromise** (no secure boot, plaintext flash). |
| T10 | Compliance / EOL policy | **Med** | **Med** ✗ **unchanged** | 18.06 is **also EOL**. From a governance/audit view "EOL OS, no vendor patches" is still true — 18.06 is not a supported branch, so it does not clear an EOL-software finding. |

**Net:** four items improved (T1, T2, T4, T5), one capability improved (T6), three unchanged
(T7, T9-exposure, T10), and the meta-risk (T8) reduced in magnitude. **No item got worse.**

---

## 4. What sitting on 18.06 retires vs. leaves outstanding

### ✅ Risks retired / materially reduced by reaching 18.06

- **KRACK (T2 headline).** The 2018 hostapd/wpad is post-KRACK — the marquee WiFi key-reinstall
  attack is closed. This was the single largest un-isolatable surface on 15.05.
- **Legacy-only SSH crypto (T4).** dropbear 2017.75 negotiates curve25519 KEX; modern clients and
  `t2-cli`'s SSH path connect without the legacy-KEX override. (The 15.05 workaround note in
  `gaps-and-risks.md` no longer applies at 18.06.)
- **Kernel 3.18 EoP tail (T1).** k4.14 closes Dirty COW and ~3 extra years of local-privilege and
  namespace bugs, with materially better hardening.
- **Dead package feed / can't-update (T6).** The 18.06 feed is signed and still online, so the
  device is no longer permanently frozen — security-relevant packages can be installed/updated
  within the branch.
- **DNSpooq (T5).** dnsmasq 2.80-1.4 carries the DNSpooq backports (18.06.9 was that release).

### ⚠️ Risks still outstanding at 18.06 (the reasons 18.06 is a waypoint)

1. **18.06 is EOL — no new security patches (T8/T10).** The branch was retired ~2021. Any CVE
   disclosed after that in the kernel, dropbear, dnsmasq, mbedTLS, hostapd, BusyBox, etc. is
   **unpatched and will stay that way** on 18.06. This is the core strategic reason to keep going.
2. **Kernel 4.14 is itself EOL (Jan 2024).** Better than 3.18, but ~3 years of kernel CVEs since
   the 4.14.206 build (Nov 2020) are unaddressed. Still relevant post-foothold (T1).
3. **On-device Node.js 8.11.3 is EOL (T7) — unchanged.** No OpenWrt version fixes this. App code
   that handles untrusted input runs on an interpreter with years of unpatched CVEs. **This is not
   a reason to prefer any particular OpenWrt version** — it is constant across all hops.
4. **WiFi is WPA2-only; FragAttacks unpatched (T2 remainder).** `wpad-mini` has no WPA3/SAE and no
   802.11w PMF, and the 2018 build predates FragAttacks (2021). The radio still bypasses wired VLAN
   isolation → **keep the radio off** per §5.1 of the baseline doc unless/until a later hop brings
   WPA3.
5. **No TLS 1.3 (T3).** System mbedTLS does TLS 1.2 well, but modern endpoints increasingly want
   1.3; Node 8's bundled OpenSSL 1.0.2 governs app egress and is EOL. Some outbound integrations
   may still degrade or break.
6. **Compliance/EOL finding stands (T10).** For a governed asset register, "EOL OpenWrt, EOL
   kernel, EOL Node" is still an audit finding at 18.06.

---

## 5. Recommendation

- **For a lab / bench / hobby / single-purpose isolated device:** sitting on **18.06.9 is a
  reasonable, comfortable accept** — strictly better than 15.05 on every axis, with the same §5
  compensating controls (radio off, single-host segment, appliance/immutable, physical security,
  registered accepted-risk, egress monitoring). Formally record it as accepted-risk EOL with a
  review date.
- **If the device will ever touch sensitive data, share a segment, need the radio, or live under
  an EOL-software policy:** 18.06 does **not** clear those — continue the uplift toward a
  **supported branch (23.05 / 24.10)**. The value there is the same as before: a *maintainable,
  patchable, crypto-current* platform, not a single-CVE fix.
- **Engineering reality (unchanged):** the remaining hops are genuine bring-up work — the
  `spid`/DTS/GPIO bridge port (CS1 done for k4.x; spidev-whitelist + libgpiod still ahead at k5.4+)
  and the entropy/urngd fix — and **none of it moves Node off 8.11.3.** Set expectations
  accordingly.

---

## 6. Bottom line

Reaching **18.06.9** was worthwhile: it retired the **KRACK**, **legacy-SSH-crypto**,
**Dirty-COW-era kernel**, **dead-feed**, and **DNSpooq** risks, and re-opened package updates —
moving the isolated-deployment residual from **LOW-to-MODERATE down to LOW.** But 18.06 is an **EOL
branch on an EOL kernel**, so it is a **defensible resting point, not a solved one**: the
compounding no-patch risk (T8), the compliance/EOL finding (T10), and the frozen on-device Node
(T7) all remain. **Sit on 18.06 with eyes open and the §5 controls in place; plan the next hop
toward a supported branch when the maintainability goal (not a specific CVE) justifies the
engineering.**

*CVE/version specifics above should be confirmed against the exact package versions in the final
production image before any formal risk sign-off; the dnsmasq DNSpooq backport in `2.80-1.4` in
particular is worth verifying explicitly.*
