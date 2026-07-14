# Security Threat Assessment — Running the Tessel 2 on OpenWrt Chaos Calmer 15.05 (i.e. *not* upgrading)

**Date:** 2026-07-14
**Author:** Revival effort (security posture review)
**Question answered:** *If we cannot / do not upgrade OpenWrt, what is the residual risk, and what capabilities do we forgo?*

---

## 1. Scope and assumptions

This assessment deliberately assumes a **favourable deployment environment**, as requested:

- The device sits on a network run by **competent IT**.
- It is placed on an **isolated/segmented VLAN**, firewalled off from other corporate hosts.
- It is **not publicly accessible** (no inbound NAT/port-forward, no public IP, not on the DMZ).
- Egress is presumed constrained but not necessarily zero (device may reach a local package mirror, NTP, or the internet for outbound calls).

Under those assumptions the classic worst case — an unauthenticated attacker on the public internet exploiting an EOL service — is **largely off the table**. The assessment therefore focuses on the residual risk that isolation does **not** remove, and calibrates likelihood accordingly (this is why several "High severity" items land at "Low–Medium residual risk").

### What the device actually runs (baseline vs. target)

| Component | Current baseline (factory image) | Upgrade target (24.10) | Notes |
|---|---|---|---|
| OpenWrt release | **Chaos Calmer 15.05‑rc2** (2015, EOL ~2016) | 24.10 | `openwrt-tessel/config.mk:77` pins the CC 15.05 package feed |
| Linux kernel | **3.18** | **6.6.144 LTS** | ~10-year gap; 3.18 last patched upstream ~2017 |
| On-device Node.js | **4.2.1** (live `t2 version`); build target 8.11.3 | still 8.11.3 (soft-float MIPS ceiling) | Node 4 EOL 2018, Node 8 EOL 2020 — both EOL either way |
| TLS library | OpenSSL 1.0.x era (EOL) | OpenSSL 3.x / modern | affects outbound HTTPS |
| SSH | Dropbear (2015) | Dropbear (2024) | legacy KEX/cipher set on old build |
| WiFi | hostapd/wpa_supplicant (2015), WPA2 only | modern, WPA3-capable | **radio = over-the-air attack surface** |
| DNS/DHCP | dnsmasq 2.7x era | dnsmasq 2.90+ | DNSpooq-class fixes only in newer |
| Package manager | opkg against a **dead** `http://` 15.05 feed | opkg against a live, signed feed | supply-chain + no-updates implication |
| Other EOL runtimes | Python 2, mjpg-streamer, bluez, etc. | modern equivalents | extra EOL surface |

> The single most important fact: **Chaos Calmer 15.05 has received no security patches for roughly a decade.** Every item below inherits from that.

---

## 2. Executive summary

**Overall residual risk in the assumed isolated deployment: LOW-to-MODERATE.**

- Network isolation is genuinely effective and neutralises the highest-impact remote scenarios.
- The residual risk is **not zero**, and is dominated by three things isolation does *not* fully cover:
  1. **The WiFi radio** — an over-the-air attack surface that ignores wired VLAN segmentation.
  2. **Outbound/at-rest crypto weakness** — a device this old increasingly *cannot* speak modern TLS, causing both security weakness and functional breakage.
  3. **The compounding "no patch stream" meta-risk** — the gap only widens over time, and a single lateral-movement foothold (from a compromised neighbour or a breach of the segmentation) meets a soft, unpatched target.
- It is a **reasonable risk to accept for a lab / bench / hobby / single-purpose isolated device**, provided the compensating controls in §5 are applied.
- It would be **hard to justify** for anything handling sensitive data, anything on a shared segment, or any environment with an EOL-software compliance policy.

---

## 3. What network isolation does — and does NOT — mitigate

| Attack surface | Neutralised by wired VLAN isolation + no public access? |
|---|---|
| Inbound exploit of SSH/DNS/mDNS/HTTP from the internet | ✅ Yes — not reachable |
| Inbound exploit from arbitrary corporate hosts | ✅ Mostly — blocked by segmentation |
| **802.11 / WiFi stack exploited over the air by a nearby attacker** | ❌ **No** — radio is not contained by wired VLANs |
| **Rogue AP / evil-twin / KRACK-style key attacks (if device is a WiFi *client*)** | ❌ **No** — over-the-air |
| **Weak outbound TLS (MITM of the device's own egress)** | ⚠️ Partial — depends on how tightly egress + on-path trust is controlled |
| **Compromised neighbour on the *same* isolated segment pivoting to the device** | ❌ **No** — isolation from *others* ≠ isolation *within* the segment |
| Malicious/compromised package feed or update artifact | ⚠️ Partial — depends on egress + artifact provenance |
| Local privilege escalation after any foothold | ❌ No — kernel/userspace bugs still present |
| Physical / USB / serial access | ❌ No — orthogonal to network posture |
| Compliance / policy / audit exposure to EOL software | ❌ No — a paperwork/risk-register problem regardless of exploitability |

**Key insight:** VLAN segmentation is a *wired-network* control. The Tessel 2 has an **onboard 2.4 GHz radio**; if WiFi is ever enabled (AP or client), a person in radio range is "on the network" in a way the switch fabric can't firewall. That is the one place where "old OpenWrt" meets "attacker-controlled input" even in a well-run network.

---

## 4. Threat register

Severity = intrinsic impact if exploited. Likelihood = probability **in the assumed isolated deployment**. Residual = net risk to accept.

| # | Threat | Primary vector | Severity | Likelihood (isolated) | Residual |
|---|---|---|---|---|---|
| T1 | Linux **kernel 3.18** local privilege escalation (e.g. Dirty COW class, CVE‑2016‑5195) | Local, post-foothold | High | Low | **Low–Med** |
| T2 | **WiFi/802.11 stack** flaws — KRACK (CVE‑2017‑13077…), FragAttacks, WPA2-only | Over the air | High | Low–Med | **Medium** |
| T3 | **Outbound TLS weakness** — EOL OpenSSL, no TLS 1.3, weak ciphers | On-path egress / MITM | Med–High | Low | **Low–Med** |
| T4 | **Dropbear SSH** legacy KEX/ciphers, old auth stack | LAN/over-the-air if reachable | Med | Low | **Low** |
| T5 | **dnsmasq** DNSpooq-class cache poisoning (CVE‑2020‑25681…) & mDNS responder bugs | LAN/segment | Med | Low | **Low** |
| T6 | **Supply chain** — opkg over `http://` against a *dead* 15.05 feed, weak/no signature verification | Egress / on-path | Med | Low | **Low** (feed dead ⇒ can't update anyway) |
| T7 | **EOL runtimes** — Node 4.2.1 / 8.11.3, Python 2 running app code | Via app-layer input | Med | App-dependent | **Med** |
| T8 | **No security patch stream** (meta-risk) — gap widens indefinitely | All of the above, over time | High | Certain (it *is* the state) | **Med** |
| T9 | **Physical / USB / serial** access — no secure boot, plaintext flash | Physical | Med | Env-dependent | **Low–Med** |
| T10 | **Compliance / policy** exposure — EOL OS on the asset register | Audit / governance | Med | Certain | **Med** |

### Narrative detail

**T1 — Kernel 3.18 local privilege escalation.** A decade-old kernel carries a long tail of known local-EoP and container/namespace bugs (Dirty COW being the canonical example). Isolation doesn't help here: this only matters *after* someone already has code execution on the box (via T2/T7). Impact is full root; likelihood is gated by getting that initial foothold.

**T2 — WiFi stack (the headline residual risk).** The MT7620 has an integrated radio and the image ships hostapd/wpa_supplicant from 2015. If WiFi is enabled:
- *As a client:* vulnerable to KRACK-style key reinstallation and rogue-AP/evil-twin attacks; WPA2-only (no WPA3/SAE, no PMF by default).
- *As an AP:* the 2015 hostapd is exposed to any device in range that can associate.
This is the one surface that **bypasses wired segmentation entirely.** Mitigation is largely operational: **keep the radio off** and use USB/Ethernet only (see §5). If the radio is off, T2 drops to negligible.

**T3 — Outbound TLS.** The device's own HTTPS calls (package fetch, NTP-over-TLS, any app calling an API) go through an EOL OpenSSL that lacks TLS 1.3 and modern cipher suites. Two consequences: (a) *security* — susceptible to downgrade/MITM if an attacker is on-path to the device's egress; (b) **functional** — a growing number of endpoints reject the legacy TLS the device offers, so outbound integrations simply **break**. This is already the reason several original Tessel cloud services can't be reached.

**T4 — SSH.** Dropbear from 2015 negotiates legacy KEX/ciphers. Modern SSH clients increasingly refuse those, so beyond the security exposure there is a **usability** cost (matches the existing "legacy SSH/KEX debt" note). In an isolated deployment reachable only via USB, exposure is low.

**T5 — DNS/mDNS services.** dnsmasq of this vintage predates the DNSpooq fixes; the mDNS responder listens on 5353. Both are only reachable by hosts that share the segment (or the radio). Low likelihood while segmented, non-zero if a neighbour is compromised.

**T6 — Supply chain / updates.** `config.mk` points opkg at `http://downloads.openwrt.org/chaos_calmer/15.05-rc2/…` — plaintext **and defunct**. So the device (a) can't get updates at all, and (b) would trust an unauthenticated mirror if one were stood up on-path. Practically this converts to "the device is frozen"; the exploitation angle is low but the *no-updates* angle feeds T8.

**T7 — EOL application runtimes.** Node 4.2.1 (EOL 2018) is what the *current* factory image runs; even the uplift can only reach Node 8.11.3 (EOL 2020) because the soft-float MIPS core caps V8. Any app code that parses untrusted input runs on an interpreter with years of unpatched CVEs. Risk scales with what you actually deploy; a fixed, trusted single-purpose script is low, an app taking network input is higher. **Note:** the OpenWrt upgrade does *not* fix this — Node stays frozen regardless — so T7 is *not* a reason favouring the upgrade.

**T8 — No patch stream (the real reason to care).** Individually many items are "Low, because isolated." Collectively, the device is a **static soft target whose exposure only grows**. Security-in-depth assumes *some* layer will eventually fail (a misconfigured switch port, a compromised host on the segment, someone toggling WiFi "just to test"). When that happens, this device offers no resistance and no path to remediation. That is the strongest argument for uplift even in a benign environment.

**T9 — Physical/USB.** No secure boot, unencrypted SPI flash, exposed UART, and (per the revival work) trivial re-flash over USB. Anyone with hands on the device owns it. Orthogonal to the OS version, but worth stating: the isolation model must include *physical* isolation to be complete.

**T10 — Compliance.** Independent of exploitability, "EOL operating system, ~10 years without patches" is frequently a **policy violation** and an audit finding on its own. If the device must live on the asset register of a governed environment, this alone can force action.

---

## 5. Compensating controls if you choose NOT to upgrade

These make "stay on 15.05" a defensible decision:

1. **Disable the WiFi radio** (remove `wpad`/hostapd from config or `wifi down` + no `wireless` config). This deletes the single biggest un-isolatable surface (T2). Use USB or wired Ethernet only.
2. **Keep it on a dedicated, single-host segment** with **no lateral peers** and deny-by-default egress; allow only the specific outbound destinations the workload needs (mitigates T3/T5/T6 and the "compromised neighbour" case).
3. **Treat it as appliance/immutable** — no on-device package installs (the feed is dead anyway), fixed trusted application code only (bounds T7).
4. **Physically secure** the unit and, where possible, disable/ignore the UART; restrict USB access (T9).
5. **Register it as accepted-risk EOL** with an owner and a review date, so T10 is a managed decision rather than a surprise finding.
6. **Log and monitor** its egress at the firewall — a frozen appliance's traffic profile should be highly predictable, making anomalies easy to spot.

With 1–6 in place, residual risk for a lab/bench/single-purpose isolated device is a **reasonable accept**.

---

## 6. What you forgo by staying on 15.05 (capability / feature gap vs 24.10)

Even setting security aside, the ~10-year jump to 24.10 brings substantive capability the 2015 build lacks:

**Security & crypto capability**
- **Active upstream patch stream** — the ability to receive fixes at all (the #1 "feature").
- **Modern TLS** — TLS 1.3, current cipher suites, working HTTPS to modern endpoints (fixes the "device can't talk to modern APIs" breakage).
- **WPA3 / SAE + 802.11w (PMF)** WiFi security; modern wpa_supplicant/hostapd.
- **Modern SSH** KEX/ciphers (curve25519 etc.) that modern clients still accept.
- **Kernel hardening** absent in 3.18 — better ASLR/KASLR, stack protectors, seccomp, namespaces, mitigations.

**Networking & platform**
- **nftables / firewall4** (vs legacy iptables), **DSA** switch model, modern **netifd**, improved IPv6 (the newer `odhcp6c`/`odhcpd`).
- **Signed opkg feeds (usign)** and a **live package repository** — thousands of maintained packages actually installable again.
- Newer **BusyBox, procd, dnsmasq, dropbear** and general userspace with a decade of bug/feature work.
- Better **filesystem, USB, and driver** support (relevant to the Tessel's webcam/storage/cellular/BT module use-cases).

**Maintainability**
- A build that tracks a **supported branch**, so future security work is *incremental patching* instead of another full 10-year archaeology project.
- Broader community/tooling compatibility (current LuCI, current SDK, current toolchain).

**Explicitly NOT gained by the upgrade (set expectations):**
- **On-device Node.js stays at 8.11.3** — the soft-float MIPS core is the ceiling, independent of OpenWrt version. Application-runtime EOL risk (T7) persists either way.
- **The hardware bridge (`spid`/`usbexecd`) must be re-ported** to modern SPI/GPIO interfaces before 24.10 is usable at all (the current upgrade blocker). So the upgrade is real engineering, not a drop-in.

---

## 7. Bottom line

- **In the assumed isolated, non-public deployment, *not* upgrading is a defensible, LOW-to-MODERATE residual risk** — *provided* the WiFi radio is off and the §5 compensating controls are applied.
- The risk that isolation **cannot** remove is concentrated in the **WiFi radio (T2)**, **outbound crypto (T3)**, and the **compounding no-patch meta-risk (T8/T10)**.
- The upgrade's value is less "patch one scary CVE" and more **"restore a maintainable, patchable, crypto-current platform"** — plus it unblocks modern TLS/WiFi/packaging. But it is genuine engineering work (bridge re-port) and it does **not** fix the on-device Node EOL.
- **Recommended posture:** if the device stays on 15.05, formally accept the risk with the §5 controls and a review date. If it will ever touch sensitive data, share a segment, or need the radio, prioritise the 24.10 uplift.

*CVE identifiers above are cited as representative of the vulnerability class for these EOL versions; exact applicability should be confirmed against the precise package versions in the built image before any formal risk sign-off.*
