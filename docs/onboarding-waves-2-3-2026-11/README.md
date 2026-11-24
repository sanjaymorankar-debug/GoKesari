# Shop onboarding: Waves 2 and 3 (WP6, WP7, WP9, WP10)

Owner brief 23-Nov-2026, Module 5. Source of truth:
`docs/onboarding-benchmark/phase-2/screens-flow-and-implementation-plan.md` §6 (WP6–WP10) and
`docs/delta/CONFLICT_REGISTER_2026-11-22.md` CF-007 to CF-010. Branch `feat/m5-onboarding-waves`, migration **0195**.

Everything new is behind three feature flags, all seeded **OFF**. With them off, the wizard, the dealer-assisted
flat form and the operator onboarding flow work exactly as before.

| Flag | Work package | What it switches on |
|---|---|---|
| `onboarding_referral_by_pin_enabled` | WP6 | "No code? Find one near you" panel + `GET /api/referral-codes/by-pincode` |
| `onboarding_assisted_mode_enabled` | WP7 | A dealer / dealer employee / operator fills in the wizard for the owner |
| `onboarding_scan_first_enabled` | WP10 | The GST / PAN photo scan opens first on phones; the reading model pre-loads |

WP8 (Hindi + Marathi, `users.preferred_lang`) is done on a separate branch by another session and is not touched
here. The new screens in this module already use `tr()` with English, Hindi and Marathi (the wizard does).

## Status per work package

| WP | Status | Notes |
|---|---|---|
| WP6 Referral help by PIN | **DEVELOPED** | Service, rate-limited API, wizard panel, tests |
| WP7 One assisted mode | **DEVELOPED (minimum)**: data model, services, the wizard's `(actor, ownerId)` path, helper's code locked, owner pay-by-link / QR, audit. **Not built:** a helper screen that drives the wizard (see "Still to do") |
| WP8 Hindi + Marathi | Out of scope here (other branch) | |
| WP9 SMS mobile OTP | **BLOCKED** | No SMS vendor and no DLT template / sender id. Nothing built (no vendor adapter) |
| WP10 Scan-first | **DEVELOPED** | Scan view opens first on phones; OCR model pre-loads |
| WP10 DigiLocker for owners (PAN-only) | **BLOCKED** | Needs live Sandbox.co.in DigiLocker keys for owners; the rider DigiLocker code is not a trivial extract |

## What existed before

- **Referral codes:** dealers (`dealers`), their territories as areas (`dealer_territories`), codes
  (`dealer_codes` → `referral_codes`, `activeCodeFor`), PIN → area mapping (`geo_area_pincodes`,
  `areaForPincode`, `geoAncestry`). The wizard's first screen had "Request a referral code" only.
- **Assisted registration:** dealer-assisted registration with the owner's one-time code
  (`src/server/dealers/assisted.ts`, `api/dealer/assisted/*`, table `dealer_assisted_sessions`) and
  operator onboarding (`services/operator-limited.ts`, `api/operator/onboarding/*`, table
  `shop_onboarding_sessions`, with a fee payment link). Both register the shop through a flat form, not the wizard.
- **Scan:** the wizard's Verify screen had a folded "Read it from a photo" section (`document-scan.tsx`,
  in-browser OCR `src/lib/kyc/browser-ocr.ts`), closed by default.

## WP6: referral help by PIN

`dealersForPincode(pin, { includePhone })` in `src/server/dealers/referral-by-pincode.ts`:

1. PIN → the most specific active area it maps to (longest prefix).
2. That area and its ancestors, closest first (locality → taluka → district → region → state).
3. Dealers whose territory (`dealer_territories`) is one of those areas.
4. Only `APPROVED` dealers that are not GoKesari's internal holder.
5. Each dealer's active main code; a dealer with none is not listed.

A dealer covering two of the areas is listed once, at the closer one. At most 5. An invalid or unmapped PIN gives
an empty list. Nothing is written.

**API** `GET /api/referral-codes/by-pincode?pin=411038` → `{ pincode, area, dealers: [{ displayName, area,
areaLevel, code, phone }] }`. The phone is filled only for a signed-in caller. Rate limit `REFERRAL_BY_PIN`:
10 look-ups a minute per user (per address when signed out). Flag off → 404.

**Screen:** on the wizard's Verify step, under the referral code, a folded "No code? Find one near you" panel
(PIN pre-filled from the GST record when known) shows dealer cards with **Use this code** (fills the code field)
and **Call** (only when a phone came back). Hidden when a code is already applied or locked.

## WP7: one assisted mode

**Data (0195):** `shop_registration_drafts` + `assisted_by_user_id`, `assisted_role`
(`DEALER` / `DEALER_EMPLOYEE` / `OPERATOR`), `assisted_session_id` (the consent session used). Null for every
existing row and for an owner registering alone.

**Services** (`src/server/services/assisted-onboarding.ts`):

- `findHelperConsent(helper, ownerId)` reuses the existing consent tables: a `dealer_assisted_sessions` row
  that is `OWNER_VERIFIED`, for this owner, not expired, of an approved dealer whose account is the helper's (or an
  active employee's, for a session made for that employee); otherwise an operator's own
  `shop_onboarding_sessions` row in the same state. No new consent table.
- `startAssistedDraft(helper, ownerId)` opens or claims the owner's OPEN draft, writes the three columns and puts
  the helper's referral code on the draft (dealer: the employee's code, else the dealer's). Refused when another
  helper holds the draft or the owner already used a different code. Audited (`onboarding.assisted_step`, STARTED).
- `actingOwnerFor(helper, ownerId)` is the `(actor, ownerId)` path: it returns the owner as the wizard's actor
  while the helper's consent is valid and the draft is the helper's. Every change made this way is audited with
  the route it went through.
- `assistedFeeLink(helper, ownerId)`: once the wizard created the shop, a payment **link** for what is due
  (the existing `SHOP_REGISTRATION_FEE` payment intent in LINK mode, the same capture handler as the operator flow)
  plus its **QR** (SVG). The owner pays on their own phone and is also sent the link (event
  `shop.registration_fee_link_sent`, in-app and e-mail). An open link for the same amount is reused. The documents
  gate before payment applies as usual.

**Code lock:** `answerDraftReferral` refuses a different code on an assisted draft (`REFERRAL_CODE_LOCKED`);
the wizard shows the code as locked.

**Wizard routes:** all 14 routes under `/api/shops/registration-draft/*` now take their actor from
`wizardActor(request)` (`src/server/api/wizard-actor.ts`). Without the header it is exactly the old
`requirePermission(SHOP_CREATE)`. With `x-gk-assist-owner: <owner id>` it goes through `actingOwnerFor` (flag,
consent, the helper's draft); the wizard services then run for the owner unchanged.

**New APIs** (signed in; the consent session is the permission; flag off → 404):

- `POST /api/assisted-onboarding/start` `{ ownerId }` → `{ draftId, role, code }`
- `POST /api/assisted-onboarding/fee-link` `{ ownerId }` → `{ shopId, amountPaise, linkUrl, qrSvg, expiresAt, created }`

The dealer and operator flat forms are unchanged and still work with the flag on or off (the plan's "retire the
old forms after one clean week" is an owner decision for later).

## WP10: scan-first

With `onboarding_scan_first_enabled` on, the wizard's Verify screen opens the photo scan by itself on a phone
(narrow screen or touch) and starts loading the OCR model in the background (`preloadBrowserOcr()` in
`src/lib/kyc/browser-ocr.ts`), so the first photo is read without the download wait. Typing the number is
still right there. Not opened once the number is verified.

## Files changed

- `drizzle/0195_onboarding_waves_2_3.sql`, `drizzle/meta/_journal.json`, `scripts/rollback-0195.sql`
- `src/server/db/schema.ts` (3 flag keys; 3 draft columns, index, check)
- `src/server/services/feature-flags.ts`, `src/components/feature-flags-panel.tsx` (labels and hints)
- `src/server/services/audit.ts` (`ONBOARDING_ASSISTED_STEP`)
- `src/server/api/rate-limit.ts` (`REFERRAL_BY_PIN`)
- New: `src/server/dealers/referral-by-pincode.ts`, `src/server/services/assisted-onboarding.ts`,
  `src/server/api/wizard-actor.ts`, `src/components/registration/referral-by-pin.tsx`
- New routes: `src/app/api/referral-codes/by-pincode/route.ts`, `src/app/api/assisted-onboarding/start/route.ts`,
  `src/app/api/assisted-onboarding/fee-link/route.ts`
- `src/app/api/shops/registration-draft/**/route.ts` (14 routes: actor from `wizardActor`)
- `src/server/services/shop-registration-wizard.ts` (assisted code lock; `referral.locked`)
- `src/components/registration/onboarding-wizard.tsx`, `src/app/shop/register/page.tsx` (panel, scan-first)
- `src/lib/kyc/browser-ocr.ts` (`preloadBrowserOcr`)
- Tests: `tests/unit/onboarding-waves-2-3.test.ts`

## Migration 0195

Additive and safe to re-run: three nullable columns, one check, one partial index, three flag rows OFF.
Rollback: `scripts/rollback-0195.sql` after deploying code without these columns.

## Tests

`tests/unit/onboarding-waves-2-3.test.ts` (15 tests, no database): resolution order (closest area first,
ancestors asked), one row per dealer, unapproved / internal / no-code dealers skipped, phone only when signed
in, cap and bad / unmapped PIN; the API 404 with the flag off, 422 for a bad PIN and the rate limit (10 a minute,
per caller); consent validity; the assisted columns and locked code written by `startAssistedDraft` and its audit;
refusal without consent (audited, nothing written); a draft held by another helper; flags off → assisted
services 404 and nothing written; wizard routes without the header use `requirePermission(SHOP_CREATE)` only.

Not run here: integration tests against PostgreSQL (no test database on this machine) and a browser check on
test.gokesari.com.

## Still to do / blocked

- **WP7 helper screen:** a page in the dealer portal and on the operator board that opens the wizard for a
  verified owner (calls `start`, then the wizard with the `x-gk-assist-owner` header, then `fee-link` and shows the
  QR). The services and APIs are ready; the screen is not built.
- **WP7 follow-ups:** mark the dealer's `dealer_assisted_sessions` row SHOP_SUBMITTED with the shop id when the
  assisted wizard creates the shop, and call `recordShopAttributionSafely` with the assisted dealer (the dealer's
  code on the draft already attributes the shop as for any code); the WP4 reminder to the helper for an unpaid
  assisted draft; retiring the flat forms (owner decision, CF-008 also overlaps RBAC Phase 6 customer assists).
- **Consent on government checks:** with assisted mode the helper ticks the DPDP check consent on the owner's
  behalf, after the owner's one-time code. Confirm with the owner that this is acceptable before switching it on.
- **WP9 SMS OTP: BLOCKED.** Needs an SMS vendor, a DLT-registered template and sender id (owner). Then: an adapter
  in `SMS_PROVIDER`, delivery webhook, sign-in by SMS for registered mobiles, `phoneVerifiedAt`.
- **WP10 DigiLocker for owners: BLOCKED.** Needs live Sandbox.co.in DigiLocker keys for owners (owner) and an
  `AADHAAR` value in `seller_verifications`. The rider flow (`services/rider-kyc.ts`) is tied to rider KYC rows;
  extracting a shared session service is not a trivial change, so it was left for when the keys exist.
- **Staging:** switch the flags on test.gokesari.com and check on a 375 × 812 phone and desktop; the Android and
  iOS apps (camera for the scan).
