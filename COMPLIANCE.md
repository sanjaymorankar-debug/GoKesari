# India Legal & Regulatory Compliance Checklist (Part 58)

**This document is a technical compliance checklist, not a legal opinion.**
It records what has been technically implemented on this platform and
against which Indian law/rule it is relevant. It is **not** a substitute for
review by a qualified Indian lawyer or compliance professional, and nothing
in this document should be read as a claim that the platform is legally
compliant. See the "Legal review warning" section at the end.

Status legend: **ACTIVE** = technical control exists and is wired up ·
**MISSING** = no technical control / data exists yet · **REVIEW REQUIRED** =
a control exists but needs a human/legal judgement call before it can be
relied on.

| Compliance Area | Law / Rule | Website Requirement | Implementation Status | Missing Requirement | Action Required |
|---|---|---|---|---|---|
| About Us | General payment-gateway / e-commerce KYC expectation | Public page describing the business and operating entity | ACTIVE — [`/about`](src/app/about/page.tsx) | Legal name/address/CIN/GSTIN shown there are still placeholders (see rows below) | Fill in `LEGAL_ENTITY` in `src/lib/legal-docs.ts` |
| Contact Us | General payment-gateway / e-commerce KYC expectation | Public page with support contact and Grievance Officer details | ACTIVE — [`/contact`](src/app/contact/page.tsx) | Grievance Officer phone/address still placeholders | Same as above |
| Privacy notice | DPDPA 2023 | Published privacy policy covering data collected, purpose, storage, sharing, retention, rights | ACTIVE — [`/legal/privacy-policy`](src/app/legal/privacy-policy/page.tsx) | Content not reviewed by counsel | Have an Indian lawyer review the policy text against actual data flows |
| Consent capture | DPDPA 2023 §6 | Free, specific, informed, affirmative consent before processing; demonstrable | ACTIVE — required checkbox on [sign-in](src/app/signin/page.tsx) gates Google OAuth; recorded per-user with policy version via [`consents.ts`](src/server/services/consents.ts) | Existing users are not re-prompted when the policy version changes | Build a re-consent banner/flow triggered by `hasCurrentConsent()` returning false |
| Data principal rights | DPDPA 2023 | Mechanism to access/correct/erase personal data | REVIEW REQUIRED — rights are described in the Privacy Policy; requests are handled via the grievance channel today, not a self-serve UI | No self-serve export/erase UI | Decide whether a manual (support-mediated) process is acceptable at current scale, or build self-serve tooling |
| Grievance Officer | IT Rules 2021, Rule 3(2) | Published Grievance Officer name, designation, contact, address | MISSING (placeholder) — structure exists at [`/legal/grievance-redressal`](src/app/legal/grievance-redressal/page.tsx), values sourced from [`LEGAL_ENTITY`](src/lib/legal-docs.ts) | Real officer name/phone/address not filled in | Replace placeholders in `src/lib/legal-docs.ts` with a real appointee's details |
| Grievance mechanism | IT Rules 2021, Rule 3(2); Consumer Protection Act 2019 §94 | Complaint submission form, ticket tracking, 24h acknowledgement / 15-day disposal | ACTIVE — public form at [`/grievance`](src/app/grievance/page.tsx), ticket-numbered records, admin dashboard shows overdue count | Acknowledgement/disposal timing is tracked, not automatically enforced (no reminders/escalation job) | Consider a scheduled job that flags/escalates complaints approaching the 15-day mark |
| Grievance privacy | General data-protection principle | Complaint details not publicly exposed | ACTIVE — ticket lookup requires ticket number **and** the original email; admin listing is permission-gated | — | — |
| Seller identity disclosure | Consumer Protection (E-Commerce) Rules 2020, Rule 5 | Legal name, address, customer care contact shown before purchase | ACTIVE — shown on [shop page](src/app/shops/[slug]/page.tsx) `Seller information` block | Shops registered before this feature may not have `legalBusinessName` set | Admin: fill in missing legal names via the new Shop compliance panel; dashboard flags this |
| Seller registration info | Consumer Protection (E-Commerce) Rules 2020 | GSTIN / business registration shown where applicable | ACTIVE — optional GSTIN field, admin-managed, shown on shop page when present | Not every shop has GSTIN on file | Same as above — populate via admin panel where applicable |
| Pre-purchase price transparency | Consumer Protection (E-Commerce) Rules 2020 | Price, taxes, delivery charge, final payable amount shown before payment | ACTIVE — [cart-view.tsx](src/components/cart-view.tsx) shows subtotal/delivery/tax/total per shop and overall | — | — |
| Return/cancellation disclosure | Consumer Protection (E-Commerce) Rules 2020 | Return, refund, cancellation terms disclosed before purchase | ACTIVE — [`/legal/refund-policy`](src/app/legal/refund-policy/page.tsx) platform default; per-shop override field (`returnPolicyText`) shown on shop page when set | Not every shop has a shop-specific policy | Optional — platform default applies where a shop hasn't set one |
| Subscription disclosure | Consumer Protection (E-Commerce) Rules 2020; general contract fairness | Quantity, frequency, price, start date, pause/modify/cancel disclosed; no silent renewal | ACTIVE — [subscribe-form.tsx](src/components/subscribe-form.tsx) shows all terms + cost estimate + wallet-sufficiency check before confirming; [`/legal/subscription-terms`](src/app/legal/subscription-terms/page.tsx) | — | — |
| Payment gateway compliance | RBI / payment aggregator rules | Payments processed via a licensed gateway; no raw card/UPI data stored | ACTIVE — Cashfree integration; card/UPI credentials never touch this server | Live credentials not yet configured in this environment | Set `CASHFREE_APP_ID`/`CASHFREE_SECRET_KEY`/`CASHFREE_ENV=production` for production; dashboard flags this |
| Wallet / stored-value boundary | RBI PPI Master Directions (by omission — platform deliberately stays outside PPI scope) | Wallet must not function as a bank/PPI: no P2P transfer, no cash-out | ACTIVE — no such endpoints exist in the codebase; explicitly disclaimed in [`/legal/wallet-terms`](src/app/legal/wallet-terms/page.tsx) | — | If P2P/cash-out is ever requested, treat it as a new regulated feature requiring its own legal review — do not bolt it onto the existing ledger |
| Promotional credit separation | Consumer protection / fair-dealing | Customer-funded balance vs. promotional credit kept distinct | ACTIVE — `wallet.ts` tracks the split; refunds restore the original split rather than converting promo credit to cash-equivalent | — | — |
| GST | GST Act | GSTIN captured where a seller/platform is registered | ACTIVE (data model) — optional `gstin` field on shops, admin-managed | Not populated for all shops; platform's own GSTIN placeholder unset | Fill in platform GSTIN in `src/lib/legal-docs.ts`; populate shop GSTINs where applicable |
| Food business licensing | FSSAI (Food Safety and Standards Act 2006) | FSSAI licence/registration number captured and shown for food-selling shops | ACTIVE — [`isFoodBusinessShopType()`](src/lib/shop-types.ts) gates the field; shown on shop page when the shop type is food-related | Field not populated for existing food shops; the correct licence *class* (Basic/State/Central) is not determined by this code | Admin: populate `fssaiLicenseNumber` per shop via the Shop compliance panel; confirm the correct licence class with each seller directly — this is a per-business determination, not something derivable from shop type alone |
| Location privacy | DPDPA 2023 (consent for precise location); general privacy expectation | Consent-gated GPS access, no silent tracking, no retention beyond necessity, never expose precise customer location to shop owners | ACTIVE (N/A) — no geolocation/GPS feature exists anywhere in the codebase today (verified: zero references to `navigator.geolocation` or similar) | Nothing to implement, because nothing collects location today | If a "shops near me" feature using device location is built later, follow the documented pattern in the Privacy Policy §1 (explicit consent prompt before any request) — do not add silent tracking |
| Cookies | IT Act / general disclosure norms | Cookie usage disclosed | ACTIVE — [`/legal/cookie-policy`](src/app/legal/cookie-policy/page.tsx); only essential session/CSRF cookies are used today, no third-party trackers | — | Update this policy first if analytics/advertising cookies are ever added |
| Auditability | General accountability / dispute-resolution readiness | Audit trail for payments, wallet, vouchers, refunds, prices, seller info, subscriptions, consent, grievances, admin actions | ACTIVE — [`audit.ts`](src/server/services/audit.ts) `AUDIT_ACTIONS` covers all of the above; every mutation records actor, before/after values | — | — |
| Data retention | DPDPA 2023 | Defined retention periods; erasure once purpose is served (subject to legal retention) | REVIEW REQUIRED — retention intent is documented in the Privacy Policy; no automated purge/anonymisation job exists | No automated enforcement of stated retention periods | Build a scheduled retention/erasure job once real usage data volume makes this material, and confirm required minimum retention periods (tax/accounting) with a professional first |
| Seller document verification | DPDP Act 2023; Consumer Protection (E-Commerce) Rules 2020; CGST Act; FSS Act 2006; MH Shops & Establishments Act 2017; Aadhaar Act 2016 | PAN, GSTIN, Udyam, FSSAI and Shop Act verified against government records, with per-check consent, encryption, retention and erasure, and suspension when a mandatory document lapses | ACTIVE (mock vendor until keys) — see [`docs/seller-verification/COMPLIANCE.md`](docs/seller-verification/COMPLIANCE.md) | Lawyer/CA sign-off on the items marked CONFIRM there; Gokesari's own FSSAI e-commerce licence; vendor DPA | See that document's §8 checklist |
| Admin compliance visibility | Internal governance | Dashboard showing per-item status, without falsely claiming "compliant" | ACTIVE — Admin → "Legal & regulatory compliance" section ([`compliance.ts`](src/server/services/compliance.ts), admin-only) shows ACTIVE / MISSING / REVIEW REQUIRED per item, never "COMPLIANT" | — | — |

## Legal / regulatory items requiring professional review

The following are **technically implemented** (a control exists in code) but
**legally require professional confirmation** before this platform is used
to transact with real customers at scale:

1. **All legal document content** (Privacy Policy, Terms, Cookie Policy,
   Refund/Shipping/Subscription/Wallet/Voucher/Seller Terms, Grievance
   Redressal) — drafted to reflect actual platform behaviour, but not
   reviewed by an Indian lawyer.
2. **Registered legal entity details** — `LEGAL_ENTITY` in
   [`src/lib/legal-docs.ts`](src/lib/legal-docs.ts) contains placeholders
   for legal name, registered address, and CIN/registration number.
3. **Grievance Officer appointment** — name, phone, and address are
   placeholders; IT Rules 2021 requires a real, reachable appointee.
4. **FSSAI licence class determination** — the platform flags *which* shops
   need an FSSAI number based on shop type, but does not and cannot
   determine which licence class (Basic Registration / State / Central
   Licence) applies to a given seller's scale and turnover — that is a
   per-business legal determination.
5. **GST treatment** — whether the platform itself needs GST registration,
   and how GST is computed/displayed/remitted for marketplace transactions,
   should be confirmed with a tax professional.
6. **Wallet / PPI classification** — the current design deliberately avoids
   RBI Prepaid Payment Instrument territory (no P2P transfer, no cash-out).
   Confirm this design still holds if wallet functionality expands.
7. **Data retention periods** — stated in the Privacy Policy but not yet
   legally confirmed against tax/accounting minimum-retention requirements.

**Do not represent this platform as "legally compliant" on the basis of
this document or the admin compliance dashboard alone.** Both describe
technical implementation status only.
