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
| Fee | By turnover (₹999 / ₹4,999 / ₹9,999 + GST) | v2 drafts: ₹1,000 shop / ₹2,500 wholesale (+ GST) from rule `onboardingV2` |
| Franchise | No shop needed; paid goes live after KYC (30-day KYC rule); free dealer waits for admin approval | Live shop required (else shop onboarding, then back); free dealer live at once; paid live on payment; plan table; no 30-day KYC rule |
| Team | Dealer adds employees by ID; admin placement | "My team": search customer by mobile / e-mail, invite, member accepts; upgrade / downgrade / remove with IST audit |
| Roles | `user_role_grants` + dealer tables | Derived marketplace roles (`src/server/onboarding-v2/roles.ts`) + `onboarding_role_history` |

## Data (migration 0215)

- `onboarding_role_history` — every role change (who, what, when).
- `team_invitations` — dealer / team-lead invitations; role added only on accept.
- `franchise_plans` — admin-managed plans; seeded `LAUNCH_1Y` (₹1,50,000 + GST per zone, 12 months).
- `registration_licence_entries` — one row per required licence (ENTER / UPLOAD / SCAN / LATER).
- `shop_registration_drafts` + `flow_version`, `identity_verified_at`, `fee_kind`, `fee_paise`,
  `fee_payment_intent_id`, `fee_paid_at`, `sla_accepted_at`; `franchise_bookings.plan_id`.
- Backfill: a wallet for every shop owner that had none; MIGRATED history rows for existing shop owners, dealers,
  franchisees and team members. Pending registrations untouched.
- Rollback: `scripts/rollback-0215-onboarding-v2.sql`.

## Defaults — "DEFAULT – confirm with Sanjay"

From the brief's "Defaults chosen":

1. Customer login: e-mail verification (Google or link) **and** mobile code both mandatory.
2. Delivery fee before payment: estimated from GPS (if allowed) or a saved address; otherwise the admin base fee
   (`onboardingV2.baseDeliveryFeePaise`, default ₹30). Exact address after payment.
3. Seller SLA accepted at step 6b, after licences.
4. Subscription plans: admin table seeded with the 1-year launch offer at ₹1,50,000 + GST per zone; the zone's tier
   price after the launch offer.
5. Team leads may add agents under themselves: rule `onboardingV2.teamLeadsCanAddAgents`, on.
6. Member acceptance required before a role is added.

Choices these rules left open (each marked in code):

7. Flag key `onboarding_v2`; staging ON by migration (database name check), production OFF until its test pass.
8. **SMS on production**: gokesari.com has no SMS provider (no MSG91 / DLT template). Rule
   `onboardingV2.mobileOtpFallbackWhenNoSms` (on): where no SMS can be sent the mobile is saved unverified rather than
   blocking every new customer. Switch it off once SMS is live to make the code strictly required.
9. Registration fee stored **before GST**, GST added on top (`feeGstExtra`), as the existing fee rules do.
10. The fee is paid before the shop type is chosen, so the pay step asks "Shop or wholesale shop?"; wholesale fixes
    the shop type to Wholesale store.
11. "Upload later" uses the existing document follow-up policy unchanged (rule `shopDocumentFollowUp`: promise period,
    reminders on the 1st and 15th, suspension after the deadline). The checkbox shows the configured period; the
    brief's "1 month" holds once an admin sets `promiseDays` to 30.
12. Licences an admin marked MUST_HAVE (Admin → Shop documents; FSSAI for food since 21-Nov) do **not** offer
    "Upload later" — enter, upload or scan only. Admins can move a licence to PROMISE to allow it.
13. Address after payment: the order goes to the shop at once; rider dispatch waits until the customer sets the
    address (the confirmation page asks for it straight away).
14. Team invite links last 7 days (`onboardingV2.teamInviteExpiryDays`).
15. Free dealer goes live at once with a GKD code; PAN and payout bank are asked before the first payout only.
16. Production release in the 23.00 IST window (owner rule of 20-Nov), flag OFF until the production test pass.

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
| 4 | `FEE` | Shop or Wholesale (#10), rule `onboardingV2` (+GST, #9), payment intent `SHOP_REGISTRATION_DRAFT_FEE` on the draft. Not paid → stays here ("pending payment"); the owner keeps the customer side. |
| 5 | `TYPE` | Existing list; wholesale fee → Wholesale store (type step skipped); a shop fee cannot pick Wholesale store. |
| 6 | `V2_LICENCES` | Per licence from Admin → Shop documents: Enter / Upload / Scan / Upload later → `registration_licence_entries`. FSSAI, Udyam, Shop Act verified online; others → operator (`PENDING_OPERATOR`). MUST_HAVE: no Upload later (#12). Later sets `documents_promised_at` → the existing follow-up (#11). |
| 7 | `ADDRESS`, `PIN` | Existing, both mandatory. |
| 6b | `SLA` | Shop row created here (PENDING_APPROVAL, fee snapshot = the draft fee, fee on the shop ledger). OTP-sign the personalised agreements (flag `seller_agreements_enabled`) or tick the Seller Terms; undertaking tick. `sla_accepted_at`. |
| 8 | live | Existing auto-approval (GST / PAN verified + fee via gateway) → live + welcome kit (banners, QR, signed EN/MR/HI copies); else `WAITING` (operator review). A v2 shop never goes live before the agreement. |

Background: wallet ensured, `onboarding_role_history` shop_owner GRANTED. `?return=<same-site path>` brings the owner
back after go-live / review. Admin: Admin → Shop documents → Registration licences (queue, promises with deadline,
approve / reject, open file).

Flow 2 defaults (also marked in code):

17. The agreement comes after address + pin (the shop row it is built from needs them); still after the licences (#3).
18. A Google sign-in counts as a verified e-mail; otherwise a code is e-mailed (the owner is already signed in).
19. Upload / Scan files are read on the device (no server OCR, D-18); kept encrypted in `registration_licence_files`,
    not copied into the shop's legal-documents register.
20. An operator's licence decision does not approve the shop by itself; Admin → Shops approves as today.
21. A second captured fee payment on one draft is not applied; it is logged for support to refund.
22. Staff continuing a registration (Unfinished registrations) cannot do the owner's identity codes, fee or agreement.
