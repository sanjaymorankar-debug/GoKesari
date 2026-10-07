# Seller verification — legal and compliance (Part 4)

**This is a technical checklist, not legal advice.** It records which Indian
laws bear on verifying sellers on Gokesari, what the code now does about each,
and what a professional must confirm. Items marked **⚖ CONFIRM** need a
lawyer (L) or chartered accountant (CA) before production use. Rule and
notification numbers are cited from public sources as of October 2026; check
each against the current text.

Status: **BUILT** = enforced in code · **PROCESS** = a step people must do ·
**⚖ CONFIRM** = needs professional sign-off.

---

## 1. Digital Personal Data Protection Act 2023 (DPDP) and DPDP Rules 2025

Seller verification processes personal data whenever the seller is an
individual or proprietor: their PAN, name, address, and certificates. A
company's PAN is not personal data, but the same controls apply to every
seller for simplicity.

| Requirement | Where it comes from | What Gokesari does | Status |
|---|---|---|---|
| Notice before consent: what data, which purpose, how to withdraw or complain | DPDP s.5; Rules (notice contents) | Consent text next to every "Verify" button (`src/lib/kyc/consent.ts`); privacy policy §5 "Seller verification" | BUILT · ⚖ CONFIRM (L) the wording |
| Free, specific, informed consent, given by a clear affirmative action | s.6(1) | A checkbox per document, never pre-ticked; the server refuses a check without it | BUILT |
| Consent can be shown later | s.6(10) | Each consent is stored with its time and the version of the wording (`consent_given_at`, `consent_version`, a `CONSENT_GIVEN` event with IP) | BUILT |
| Purpose limitation | s.4, s.6(1) | Used only to verify the shop, re-check it while listed, and show the seller details the law requires. Re-checks are named in the consent text | BUILT · ⚖ CONFIRM (L) that periodic re-checks fit under the original consent |
| Erase once the purpose is served, unless a law requires keeping it | s.8(7) | Daily job erases numbers, certificates and history `retentionDaysAfterClosure` days (default 1,095) after a shop is rejected, made inactive or deleted. The admin erase route handles requests | BUILT · ⚖ CONFIRM (L+CA) the period — see §7 |
| Reasonable security safeguards | s.8(5) | AES-256-GCM for numbers and certificates; masked display; keyed blind index instead of plaintext lookups; append-only history; every reviewer view of a certificate audited; keys only in server environment variables | BUILT |
| Processor bound by contract | s.8(2) | The KYC vendor is a data processor | PROCESS — sign a data processing agreement with Gridlines covering use only for the check, retention ≤ 30 days, storage in India, sub-processors, breach notice |
| Breach notice to the Data Protection Board and affected people (Rules: Board within 72 hours) | s.8(6); Rules | Not automated | PROCESS — add seller verification to the incident runbook · ⚖ CONFIRM (L) timelines |
| Rights: access, correction, erasure, grievance | ss.11–13 | Sellers see their own data at `/shop/verification`; can replace a document; erasure via grievance → admin erase route; grievance officer exists platform-wide | BUILT (erasure is admin-mediated) |
| Keep processing logs for at least one year | Rules (log retention) | Verification events and audit logs are kept until the shop's data is erased (≥ 3 years by default) | BUILT · ⚖ CONFIRM (L) |
| Children's data | s.9 | Not relevant — sellers are businesses or adults | — |

**Commencement:** the DPDP Rules 2025 were notified in November 2025 with a
phased start; most fiduciary obligations apply about 18 months later. Building
to the standard now avoids a retrofit. ⚖ CONFIRM (L) the dates that apply.

**Until DPDP fully applies:** IT Act 2000 s.43A and the SPDI Rules 2011
(reasonable security practices) apply. The controls above meet those too.

## 2. Consumer Protection (E-Commerce) Rules 2020

Gokesari is a *marketplace e-commerce entity*.

| Requirement | What Gokesari does | Status |
|---|---|---|
| Marketplace shows each seller's business name, whether registered, address, customer care contact and rating before purchase (Rule 5) | `/shops/{slug}/contact`: legal name, owner, address, contact, GSTIN, FSSAI number, return policy, and now **"Verified by Gokesari: PAN, GSTIN, …"** | BUILT |
| Sellers must give the marketplace their legal name, address, contact, GSTIN and PAN where applicable, and must not misrepresent (Rule 6) | Seller terms "Information you must provide" and the new "Document verification" section; verified GSTIN and legal name are copied to the public seller details | BUILT · ⚖ CONFIRM (L) seller terms |
| Help consumers identify sellers involved in a complaint | Verified identity on file; grievance flow exists | BUILT |
| Grievance officer, 48-hour acknowledgement, one-month redressal (Rule 4) | Existing platform grievance system | Existing — see root `COMPLIANCE.md` |

## 3. GST — sellers supplying through an e-commerce operator

| Point | Position (verify) | What Gokesari does | Status |
|---|---|---|---|
| Compulsory registration for anyone supplying goods through an operator that collects TCS | CGST Act s.24(ix) | — | context |
| **Small intra-state sellers of goods are exempt** from that compulsory registration from 1 Oct 2023 if: turnover is below the threshold, they supply only within their state, they have a PAN, they declare on the GST portal and obtain an **enrolment number**, and the operator doesn't let them make inter-state supplies | Notification 34/2023-Central Tax | "Not GST-registered" path: declaration text, optional enrolment number (format-checked, Aadhaar refused), admin review, shop's `gstStatus = NOT_REGISTERED`. Gokesari is local, so supplies are intra-state | BUILT · ⚖ CONFIRM (CA) the conditions, whether to make the enrolment number mandatory, and the operator's duties for these sellers |
| Service providers through an operator: threshold exemption | Notification 65/2017-CT | Not specifically handled | ⚖ CONFIRM (CA) if service shops list |
| **TCS by the operator** on net taxable supplies of registered sellers (rate cut to 0.5% from 10 Jul 2024); monthly GSTR-8 | CGST s.52; Notification 15/2024-CT | **Not built** — finance module | ⚖ CONFIRM (CA) · PROCESS |
| **Restaurant services through an operator: the operator pays GST**, not the restaurant | CGST s.9(5); Notification 17/2021-CT(R), from 1 Jan 2022 | Not built. Shop types RESTAURANT, FAST_FOOD and CAFE exist on Gokesari | ⚖ CONFIRM (CA) before listing restaurants — this changes who invoices and pays |
| Thresholds: ₹40 lakh goods (Maharashtra), ₹20 lakh services | CGST s.22 and notifications | Declaration text refers to "the threshold" without a figure | ⚖ CONFIRM (CA) |
| GSTIN must be active, and its PAN, name and state must match | — | Vendor check + embedded-PAN link + state check + 30-day re-check; cancelled GSTIN → shop suspended | BUILT |

## 4. FSSAI — e-commerce food business operators and their sellers

| Point | Position (verify) | What Gokesari does | Status |
|---|---|---|---|
| Every food business needs a registration (basic, roughly up to ₹12 lakh turnover) or licence (State or Central) | FSS Act 2006 s.31; FSS (Licensing & Registration) Regulations 2011 | FSSAI required for food shops (shop type **or** any food-aisle category); vendor check of status, type and expiry | BUILT |
| **The marketplace itself is an e-commerce FBO and needs its own FSSAI licence (Central)** | FSSAI e-commerce guidelines (2017, amended), Licensing Regulations Schedule 1 | — | **PROCESS** · ⚖ CONFIRM (L) — obtain before food sellers go live |
| Operator lists only sellers with a valid licence and must delist those without | E-commerce guidelines | Unverified FSSAI → listed as missing; expired or cancelled → automatic suspension (daily job); 30-day expiry warning | BUILT |
| Display the seller's FSSAI licence number to buyers | E-commerce guidelines | Shown on the seller page; verified number written through | BUILT |
| Licence category matches the business (basic vs State vs Central) | Licensing Regulations | Licence type stored and shown to reviewers; not judged automatically | ⚖ CONFIRM (L) per seller where in doubt |
| Shelf life at delivery, hygiene, labelling | FSSAI directions | Out of scope for verification | PROCESS |

## 5. Maharashtra Shops and Establishments (Regulation of Employment and Conditions of Service) Act 2017

| Point | Position (verify) | What Gokesari does | Status |
|---|---|---|---|
| **10 or more workers:** registration (Form A → certificate in Form B, with a Labour Identification Number) | MH S&E Act 2017 s.6 | Certificate upload + number; vendor check where available | BUILT |
| **Fewer than 10 workers:** no registration; an online **intimation in Form F** within 60 days of starting, with a receipt (Form G) issued online | s.7 | Seller screen says a Form G receipt is accepted; admin compares it with the typed number | BUILT · ⚖ CONFIRM (L) that a Form G receipt is sufficient evidence |
| No public verification API; a portal "verify certificate" page may exist (18-digit barcode) | — | Manual review queue; the reviewer can check the Aaple Sarkar portal | PROCESS |
| Required for every Gokesari seller? | Applies to establishments in Maharashtra; home-based sellers and other states differ | `SHOP_ACT` is mandatory for every shop in code (`requirementFor`) | ⚖ CONFIRM (L) — make it optional for categories the law doesn't cover |
| Certificate renewal | The 2017 Act registration generally has no renewal | Expiry handled only if a date exists | ⚖ CONFIRM (L) |

## 6. Aadhaar

| Point | Position | What Gokesari does | Status |
|---|---|---|---|
| Private entities may not collect or store Aadhaar numbers except through an authorised route (licensed AUA/KUA, offline XML or DigiLocker with masking) | Aadhaar Act 2016 ss.8, 29, 57 as read in *K.S. Puttaswamy v. Union of India* (2018); Aadhaar (Sharing of Information) Regulations 2016 | **Never collected.** Every document field and the GST enrolment field refuse any 12-digit number with a valid Aadhaar (Verhoeff) check digit; Udyam refuses bare 12-digit numbers; no vendor Aadhaar field (e.g. masked Aadhaar from PAN products) is mapped or stored; sellers are told to mask Aadhaar on uploads | BUILT |
| Uploaded certificates might still show an Aadhaar number | — | Reviewer instruction: reject and ask for a masked copy | PROCESS |

## 7. Retention period — what a professional must set

The default is to erase verification data **3 years (1,095 days)** after a
shop stops selling. That is a placeholder chosen to cover:
- the 2-year limitation for consumer complaints (Consumer Protection Act 2019 s.69);
- disputes with the seller.

It does **not** cover GST record-keeping (72 months, CGST s.36), which applies
to tax invoices and returns, not to identity checks. ⚖ CONFIRM (L+CA) the
period, then set `retentionDaysAfterClosure` in admin settings — no deploy
needed.

## 8. Before production — checklist

- [ ] Lawyer reviews: consent text, GST declaration text, privacy policy §5, seller terms "Document verification", Shop Act applicability, retention period.
- [ ] CA reviews: GST declaration and enrolment path, TCS (s.52), restaurant GST (s.9(5)) before listing restaurants.
- [ ] Gokesari's own FSSAI e-commerce licence obtained.
- [ ] Data processing agreement signed with Gridlines (and IDfy if used).
- [ ] Incident runbook updated for verification data breaches.
- [ ] `LEGAL_ENTITY` placeholders in `src/lib/legal-docs.ts` filled in (vendor KYC needs them too).
- [ ] Decide whether to bump `CURRENT_POLICY_VERSION`. The privacy policy changed; bumping it re-prompts users once the re-consent flow exists.
