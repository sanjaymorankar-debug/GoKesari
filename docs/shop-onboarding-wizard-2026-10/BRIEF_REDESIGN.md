# Shop registration redesign — "follow the brief" (owner decision, 29 Oct 2026)

The onboarding wizard at `/shop/register` (flag `shop_onboarding_wizard_enabled`) now follows the
owner's registration brief. Decisions: [decision log D-B01 … D-B09](../decision-log.md#shop-registration-redesign-29-oct-2026-owner-follow-the-brief).
It replaces, **for wizard shops only**, the 29 Oct documents gate in
[docs/shop-documents-2026-10](../shop-documents-2026-10/README.md); shops registered on the long form
or by staff keep that gate unchanged.

## The ten steps (shown as a Tile Board at the top of the page)

| # | Tile | What happens | Server step |
|---|---|---|---|
| 1 | GST number | "Do you have a GST number?" Yes → GSTIN → government check; on success PAN, shop name, owner name and registered address are filled from the GST record (the PAN inside it is checked silently) | `IDENTITY` (`POST …/gstin`) |
| 2 | PAN | No GST → "Do you have a PAN number?" Yes → PAN + "not GST-registered" declaration → check; name filled from PAN. No → **"A valid PAN or GST is required to register"**, with the note that PAN-only and GST + PAN are allowed for shops, professionals (advocates, doctors, CAs), companies, industries and startups | `IDENTITY` (`POST …/pan`) |
| 3 | Udyam | Optional: number → check | `UDYAM` |
| 4 | FSSAI | Number → check (expiry, premises PIN). Mandatory for a food shop type: choosing one on step 5 sends the owner back here; "No" does not get a food shop past it | `FSSAI` |
| 5 | Turnover & fee | Review / edit the filled-in name and address, shop type, mobile, referral / coupon code; pick a **turnover slab** — the fee comes from the admin's slab table (rule `registrationFeeByTurnover`); then "Create my shop and pay" | `DETAILS` → `REVIEW` |
| 6 | Payment | Cashfree (UPI, card). Not paid / failed: **pending admin approval** message; the owner may browse as a customer; the shop gets no orders (only APPROVED shops take orders) | `PAYMENT` |
| 7 | Approval | Paid + GSTIN (or PAN) VERIFIED (+ FSSAI for food, shop-type licences) → **approved automatically** and the "registration successful, ready for product upload" email goes out. Otherwise "pending admin approval" with the reason | `WAITING` / approved |
| 8 | Location | Google Maps pin, saved on the live shop (`PATCH /api/shops/[id]`) | `LOCATION` |
| 9 | Category | Shop categories (`PUT /api/shops/[id]/categories`) | `CATEGORY` |
| 10 | Products | Product-list upload (`/shop/product-import`) or one by one | `PRODUCTS` → `DONE` |

## Approval rule (wizard shops)

| | Before (29 Oct gate) | Now |
|---|---|---|
| May pay | ≥ 1 document verified, rest verified or promised (30 days) | GSTIN (or PAN without one) checked and not refused |
| Auto-approved | every mandatory document verified + paid | GSTIN (or PAN) **VERIFIED** by the source + paid through the gateway + FSSAI VERIFIED for food + shop-type licences |
| Shop Act | before payment (or promised) | after go-live on Documents; chased 1st / 15th, suspended after 3rd reminder |
| Database rule | `shop_kyc_complete` (0113) | same, plus the wizard branch (0118) |

Code: `drizzle/0118_registration_identity_approval.sql` (rollback `scripts/rollback-0118.sql`),
`src/server/services/shop-onboarding.ts` (`isWizardRegisteredShop`, `missingMandatoryDocuments`),
`shop-document-gate.ts`, `gov-auto-approval.ts`, `shop-registration-wizard.ts`,
`src/components/registration/onboarding-wizard.tsx`.

## Checked, already in place

- Referral code mandatory / optional, per audience (customers, shops), admin only, default optional — Admin → Referral settings.
- Dealer commission by amount and/or percentage, admin only — Admin → Dealers → Commission.
- ₹1 bank-account check by UPI or card — `/api/bank-account/verification`.
- Registration on behalf of an owner by admin / operator — `/operator/onboard`.
- Mobile apps (`mobile/`) are WebView shells: no native change.

## Tests

`tests/integration/onboarding-wizard-step2.test.ts` (both database layouts): step order and resume;
Udyam / FSSAI success, not found, expired, vendor down; food shop sent back to FSSAI; GSTIN verified +
payment → auto-approved without Shop Act, email, then location → category → products; PAN-only →
auto-approved; no payment / failed payment / GSTIN pending / PAN name mismatch / FSSAI pending →
pending admin approval; referral toggle mandatory ↔ optional (admin only); a long-form shop keeps the
29 Oct gate.

## Blockers for production

- **GST / PAN / FSSAI government checks are mock-only** (`KYC_PROVIDER=mock`) until the Gridlines
  sandbox and live keys arrive. With `KYC_ENV=production` the mock's answers never count for
  auto-approval (`gov-auto-approval.ts`), so every production wizard shop stays **pending admin
  approval** after payment; without it, the "checks" are the mock's, not the government's — neither
  is a real GST / PAN validation. Unblock: set `KYC_PROVIDER=gridlines`,
  `GRIDLINES_*` keys and `KYC_ENV=production` on Hostinger (docs/seller-verification/DEPLOY.md).
- Lawyer / CA sign-off for going live before the Shop Act review (as for 0113).
