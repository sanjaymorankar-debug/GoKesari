# Onboarding v2 — customer, shop, franchise, team (owner brief 26 Nov 2026, 06.19 PM IST)

Feature flag **`onboarding_v2`** (Admin → Feature flags). Migration **0215** seeds it **ON on the staging
database (`gokesari_test`)** and **OFF on production**. With the flag off every flow behaves exactly as before.
All times in this document and in every v2 screen are IST.

> The brief mentions "separate seller and customer databases". That split was removed in Nov 2026 (CLAUDE.md):
> each site has one database. v2 keeps the one rule that survived — no foreign keys between seller and customer
> tables; services check those links.

## What existed (26 Nov 2026) and what v2 changes

| Area | Existed | v2 |
|---|---|---|
| Guest browsing | Search, shops, nearby, product pages open; browser cart behind `guest_cart_enabled` | No sign-in anywhere before checkout (also `/r/<code>` shop QR links, `/wa/cart`) |
| Sign-in | Email code, magic link, Google; SMS only as a flagged second factor | Sign-in sheet at "Place order": Terms tick (version + time) → e-mail (Google or link) → mobile code → account + wallet |
| Address | Chosen before payment | Delivery address after payment (GPS + pin or saved address); not asked for pickup |
| Shop registration | Sign-in → referral → GST/PAN → type → licences → address → pin → shop → documents → SLA → pay | Identity → referral → GST/PAN → **fee** → type → licences (4 options) → SLA → address + pin → live |
| Fee | By turnover (₹999 / ₹4,999 / ₹9,999 + GST) | Unchanged amounts and slabs (owner 27-Nov): the same turnover slabs + GST, paid on the draft right after GST / PAN |
| Franchise | No shop needed; paid goes live after KYC (30-day KYC rule); free dealer waits for admin approval | Live shop required (else shop onboarding, then back); free dealer = a request an admin approves (owner 27-Nov 17.30, replaces "live at once"); paid live on payment; plan table; no 30-day KYC rule (decided by owner 27-Nov) |
| Team | Dealer adds employees by ID; admin placement | "My team": search customer by mobile / e-mail, invite, member accepts; upgrade / downgrade / remove with IST audit |
| Roles | `user_role_grants` + dealer tables | Derived marketplace roles (`src/server/onboarding-v2/roles.ts`) + `onboarding_role_history` |

## Data (migration 0215; 0220 for the owner decisions of 27-Nov)

- 0220: `legal_acceptances.signature_method` / `legal_signing_requests.signature_method` (`SMS_OTP` default,
  `REGISTRATION_ACCEPT`), `shop_suspensions.source` (`DOCUMENT_FOLLOW_UP`). Rollback:
  `scripts/rollback-0220-onboarding-v2-owner-decisions.sql`.

- `onboarding_role_history` — every role change (who, what, when).
- `team_invitations` — dealer / team-lead invitations; role added only on accept.
- `franchise_plans` — admin-managed plans; seeded `LAUNCH_1Y` (₹1,50,000 + GST per zone, 12 months).
- `registration_licence_entries` — one row per required licence (ENTER / UPLOAD / SCAN / LATER).
- `shop_registration_drafts` + `flow_version`, `identity_verified_at`, `fee_kind`, `fee_paise`,
  `fee_payment_intent_id`, `fee_paid_at`, `sla_accepted_at`; `franchise_bookings.plan_id`.
- Backfill: a wallet for every shop owner that had none; MIGRATED history rows for existing shop owners, dealers,
  franchisees and team members. Pending registrations untouched.
- Rollback: `scripts/rollback-0215-onboarding-v2.sql`.

## Owner decisions of 27-Nov-2026 (~00.15 IST)

1. **Fee** — "keep the original fees as it is not change in amount and slabs": the v2 fee step asks the annual
   turnover band (the original wizard's bands and wording) and charges that slab of rule `registrationFeeByTurnover`
   (₹999 / ₹4,999 / ₹9,999 before GST by default) + GST, or the flat registration fee when that rule is off — the
   same `quoteRegistrationFee` as the original, registration-fee coupons included (recorded on the shop). No Shop /
   Wholesale question: a wholesale store pays the same slab and picks Wholesale store at the shop-type step. Rule
   fields `onboardingV2.shopFeePaise / wholesaleFeePaise / feeGstExtra` are removed. "ok for shop it should be 999":
   the production test pays the ₹999 band. Drafts that paid the earlier fee by kind keep it (fee_kind column).
2. **Licences** — "all documents there should be grace period as per the earlier defined policy … suspended … activated
   post documents are provided … no additional admin approval is required": every licence of a v2 registration,
   MUST_HAVE ones included, may be uploaded later within the existing `shopDocumentFollowUp` period. **This reverses
   the 21-Nov rule "FSSAI before live" for v2 registrations — owner-confirmed 27-Nov-2026 00.30 IST: "Yes, FSSAI can be
   uploaded later".** No licence and no operator check holds a v2 shop's
   go-live (GST / PAN verified + fee paid still decide the instant go-live). The follow-up reminds and suspends as
   before (suspension tagged `source = DOCUMENT_FOLLOW_UP`, migration 0220); with the flag on, such a shop is
   **reinstated automatically** (audit + owner notice) as soon as nothing is chased — right after a document is
   given (seller documents, Shop Act certificate, FSSAI upload, legal-documents register, a registration licence
   decision) and in the daily follow-up run. A licence entered / uploaded at registration counts as given. A shop
   suspended for any other reason is never reinstated automatically. Optional documents never block anything.
3. **Agreement** — "when seller want to review the terms the only OTP is required, while shop registration to see the
   terms and condition OTP is not required": at the v2 registration the personalised SLA (+ medical agreement) is
   accepted with the ticks and the typed name, no SMS code (`signature_method = REGISTRATION_ACCEPT`, 0220); the
   signed copies (EN / MR / HI) are still e-mailed with the welcome kit. Reviewing or re-signing later from the shop
   dashboard keeps the OTP.
4. Free dealer: a request an admin approves, then the GKD code (owner 27-Nov 17.30; was "live at once"); paid franchise live on payment without the 30-day KYC rule — decided by owner 27-Nov
   (already built).
5. Mobile OTP unchanged (production flag stays off until the SMS provider PR #632 is live).

## v3 order (28-Nov-2026, migration 0231)

Owner decisions (Sanjay, 28-Nov-2026). A shop registration started while `onboarding_v2` is on keeps
`flow_version = 'v2'` (all v2 safeguards unchanged) and gets `flow_order = 'v3'` (rule
`onboardingV2.shopRegistrationOrder`, default `v3`; `v2` switches new drafts back). Drafts started before keep the
v2 order. Code: `src/server/onboarding-v2/early-agreement.ts`, `licence-renewals.ts`; tests:
`tests/integration/onboarding-v3-shop.test.ts`.

1. **Referral code.** A guest gives it on `/shop/register` (checked with the REFERRAL step's rule,
   `POST /api/shops/registration-draft/v2/guest-referral`); a shared link's code (`/r/<code>` cookie or `?ref=`) is
   checked silently and the referral screen is never shown — only a missing or invalid code shows step 1, with a plain
   message. Saved on the draft once signed in (`details.referralSource` = `SHARED_LINK` / `GUEST_CONFIRMED`, audit
   `shop_registration_draft.referral_auto_applied`).
2. **Identity + seller agreement.** The customer login sheet (Terms, e-mail code, mobile code) is the identity step
   for guests (no separate customer sign-up); a verified customer skips it. Then `V3_AGREEMENT`: the published
   template text (generic SLA; personalised copy follows go-live), Seller Terms / Terms / Privacy, goods undertaking,
   the promise to upload or renew licences within `promiseDays` of go-live, and the typed name. Stored on the draft
   (`early_agreement_*`).
3. GST / PAN → owner name → 4. fee (flat ₹999 + GST) → 5. shop type → 6. address + pin.
7. **Live.** "Create my shop and go live": every licence not given is promised (registration_licence_entries
   LATER / PROMISED, documents_promised_at), the shop is created, the stored acceptance is applied
   (`applyEarlyRegistrationAcceptance`: REGISTRATION_ACCEPT with the stored name, time and IP; undertaking;
   `sla_accepted_at`) and the existing `goLiveV2` runs; signed copies e-mailed as before. A document the owner did not
   see at step 2 (newer version, medical agreement) is still shown on the SLA screen. The shop's address becomes the
   owner's saved delivery address "Shop" (default only if none).
8. **Licences after go-live** (`V3_LICENCES`): upload now (My shop → Documents) or later; the existing follow-up
   (90 days, reminders 1st / 15th, suspension, automatic reactivation) chases them.

**Expired licence at a registration (owner, 28-Nov-2026 ~11.50 IST).** For a v2 / v3 registration not live yet, an
expired licence no longer blocks: the owner ticks a renewal promise ("<Licence> expired on <date> — renew and upload
the new one within <N> days or the shop will be paused."); recorded as a PROMISED entry with `expired_on` /
`renewal_promised_at` + audit `shop_registration_draft.licence_renewal_promised`; the follow-up chases it like a missing
promised licence (an expired copy on file does not count). Live shops and original-wizard (v1) registrations keep the
old rule (missing / expired licences block signing). Rollback: `scripts/rollback-0231-shop-onboarding-v3.sql`.

## Defaults — "DEFAULT – confirm with Sanjay"

From the brief's "Defaults chosen":

1. Customer login: e-mail verification (Google or link) **and** mobile code both mandatory.
2. Delivery fee before payment: estimated from GPS (if allowed) or a saved address; otherwise the admin base fee
   (`onboardingV2.baseDeliveryFeePaise`, default ₹30). Exact address after payment.
3. Seller SLA accepted at step 6b, after licences — accepted without OTP: decided by owner 27-Nov (#3 above).
4. Subscription plans: admin table seeded with the 1-year launch offer at ₹1,50,000 + GST per zone; the zone's tier
   price after the launch offer.
5. Team leads may add agents under themselves: rule `onboardingV2.teamLeadsCanAddAgents`, on.
6. Member acceptance required before a role is added.

Choices these rules left open (each marked in code):

7. Flag key `onboarding_v2`; staging ON by migration (database name check), production OFF until its test pass.
8. **SMS on production**: gokesari.com has no SMS provider (no MSG91 / DLT template). Rule
   `onboardingV2.mobileOtpFallbackWhenNoSms` (on): where no SMS can be sent the mobile is saved unverified rather than
   blocking every new customer. Switch it off once SMS is live to make the code strictly required.
9. ~~Registration fee stored before GST (`feeGstExtra`)~~ — decided by owner 27-Nov: the original fee rules + GST.
10. ~~The pay step asks "Shop or wholesale shop?"~~ — decided by owner 27-Nov: it asks the turnover band; wholesale
    pays the same slab and chooses its type afterwards.
11. "Upload later" uses the existing document follow-up policy unchanged (rule `shopDocumentFollowUp`: promise period,
    reminders on the 1st and 15th, suspension after the deadline). The checkbox shows the configured period; the
    brief's "1 month" holds once an admin sets `promiseDays` to 30.
12. ~~MUST_HAVE licences do not offer "Upload later"~~ — decided by owner 27-Nov: every licence offers it (FSSAI too).
13. Address after payment: the order goes to the shop at once; rider dispatch waits until the customer sets the
    address (the confirmation page asks for it straight away).
14. Team invite links last 7 days (`onboardingV2.teamInviteExpiryDays`).
15. ~~Free dealer goes live at once~~ → replaced 27-Nov-2026: the free dealer request waits for an admin's approval, which issues the GKD code; PAN and payout bank are asked before the first payout only —
    decided by owner 27-Nov.
16. Production release in the 23.00 IST window (owner rule of 20-Nov), flag OFF until the production test pass.

## Flow 4 — My team (built 26-Nov-2026)

- Dealer / franchisee: **/dealer/team** (linked from /dealer and /franchise/my). Search a customer by exact mobile or
  e-mail (masked name), choose the role (team lead, or agent under the dealer or one of his leads), send the request.
  No account → invite link `/team/join/<token>` (sha256 stored, `teamInviteExpiryDays`) shared on WhatsApp / SMS / e-mail.
- Team lead: adds agents under himself on the same page while `teamLeadsCanAddAgents` is on.
- Invitee: **/team/invitations** (in-app + e-mail + SMS notice `dealer.team_invitation`) — accept or decline. Accept
  creates (or reactivates) the `dealer_salespeople` row through `addSalesperson` / `placeNewMember` (GKT / GKA code,
  mapping history), so the commission chain is unchanged (integration test: 20 / 4 / 3).
- Dealer only: agent → team lead, team lead → agent after his agents are reassigned, reassign, remove (customer only).
  Admin → user page: marketplace roles, role history (IST) and an override (OVERRIDE). API: `/api/team`,
  `/api/team/invitations`, `/api/users/<id>/marketplace-roles`. Code: `src/server/onboarding-v2/team.ts`.
- Defaults chosen in code (DEFAULT – confirm with Sanjay): mobile must be SMS-verified unless
  `mobileOtpFallbackWhenNoSms` is on; an invite link only works for the account holding the invited mobile / e-mail;
  employee ID generated `GK-<8>`; v2 upgrade skips the TIERED promotion minimums and starts no development bonus;
  inactive former agents of a downgraded lead move under the dealer; admin override is immediate (no four-eye);
  no `DEALER` role grant on accept (team roles derive from `dealer_salespeople`).
- Accept is one transaction under advisory locks (account + invitation) and refuses an account already ACTIVE in
  another team (DEFAULT). No database-wide unique index: the existing rules let one person sit in two dealer
  networks (admin path, dealer-payouts DP-2), so a 0219 index was dropped before release. "Verified e-mail / mobile" is the checkout sheet's
  definition (Google account counts). Search answers "not found" alike for no account / incomplete / dealer / other
  team. Rate limits (DEFAULT): search 30/hour per dealer + 60/hour per IP; requests 20/day per dealer + 40/day per IP.

## Owner-only steps (blocked for an agent)

- Production test payments (₹1,000 shop fee, ₹1,50,000 franchise plan) use real money — owner runs them.
- Real SMS codes on production need an SMS vendor + DLT template.
- Switching `onboarding_v2` ON on production after the production test pass.

## Flow 2 — shop onboarding (migration 0217, branch ov2/shop)

Only for drafts with `flow_version = 'v2'` (every draft started while `onboarding_v2` is on); older drafts and the flag
off keep the original wizard. Code: `src/server/onboarding-v2/shop-flow.ts` (actions), `shop-view.ts` (view),
`src/components/registration/onboarding-v2-steps.tsx`, routes `/api/shops/registration-draft/v2/*`.

| # | Step | v2 behaviour |
|---|---|---|
| 1 | `V2_IDENTITY` | Terms tick (consent TERMS_AND_PRIVACY, version + time) + e-mail (Google sign-in, or a code) + mobile SMS code. Skipped for a customer whose e-mail and mobile are both verified. No SMS + `mobileOtpFallbackWhenNoSms` → mobile saved unverified (#8). |
| 2 | `REFERRAL` | Existing (admin toggle mandatory / optional, "Request a referral code" + e-mail). |
| 3 | `IDENTITY` / `OWNER` | Existing GST or PAN online check; shop + owner name pre-filled. |
| 4 | `FEE` | Annual turnover band → the original slab fee (+GST, coupon optional; flat fee when fees by turnover are off) — owner 27-Nov; payment intent `SHOP_REGISTRATION_DRAFT_FEE` on the draft. Not paid → stays here ("pending payment"); the owner keeps the customer side. |
| 5 | `TYPE` | Existing list, Wholesale store included (owner 27-Nov). |
| 6 | `V2_LICENCES` | Per licence from Admin → Shop documents: Enter / Upload / Scan / Upload later → `registration_licence_entries`. FSSAI, Udyam, Shop Act verified online; others → operator (`PENDING_OPERATOR`, checking only — never holds go-live). Upload later for every licence, MUST_HAVE / FSSAI too (owner 27-Nov). Later sets `documents_promised_at` → the existing follow-up (#11), suspension, automatic reinstatement. |
| 7 | `ADDRESS`, `PIN` | Existing, both mandatory. |
| 6b | `SLA` | Shop row created here (PENDING_APPROVAL, fee snapshot = the draft fee, fee on the shop ledger). Accept the personalised agreements with ticks + typed name, no OTP (flag `seller_agreements_enabled`; owner 27-Nov) or tick the Seller Terms; undertaking tick. `sla_accepted_at`. |
| 8 | live | Existing auto-approval (GST / PAN verified + fee via gateway) → live + welcome kit (banners, QR, signed EN/MR/HI copies); else `WAITING` (GST / PAN review). No licence holds it (owner 27-Nov). A v2 shop never goes live before the agreement. |

Background: wallet ensured, `onboarding_role_history` shop_owner GRANTED. `?return=<same-site path>` brings the owner
back after go-live / review. Admin: Admin → Shop documents → Registration licences (queue, promises with deadline,
approve / reject, open file).

Flow 2 defaults (also marked in code):

17. The agreement comes after address + pin (the shop row it is built from needs them); still after the licences (#3).
18. A Google sign-in counts as a verified e-mail; otherwise a code is e-mailed (the owner is already signed in).
19. Upload / Scan files are read on the device (no server OCR, D-18); kept encrypted in `registration_licence_files`,
    not copied into the shop's legal-documents register.
20. ~~An operator's licence decision … Admin → Shops approves~~ — decided by owner 27-Nov: no approval step for
    licences at all; the operator queue is for checking only.
21. A second captured fee payment on one draft is not applied; it is logged for support to refund.
22. Staff continuing a registration (Unfinished registrations) cannot do the owner's identity codes, fee or agreement.
