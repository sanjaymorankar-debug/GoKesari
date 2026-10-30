# Test results — shop registration single flow (owner brief, 30 Oct 2026, evening)

Branch `fix/registration-single-flow` (from `staging` at 2afa3104), PR #298 into `staging`.
Design: [FLOW_2026-10-30-b.md](FLOW_2026-10-30-b.md). Tracker: `SHOP_REGISTRATION_SINGLE_FLOW_TRACKER_2026-10-30.xlsx`.

**Where it was tested:** locally (Postgres 18, mock KYC provider, sandbox payment), on both database
layouts. **Not yet** on test.gokesari.com (the PR is not merged) or gokesari.com (the owner chose
"staging now, Prod later": production waits for an approved release window).

## Automated

| Run | Layout | Result |
|---|---|---|
| `shop-registration-flow`, `onboarding-wizard-step1`, `onboarding-wizard-step2` | single DB | 59 / 59 pass |
| same | split (core + seller) | 59 / 59 pass |
| 25 registration / referral / approval / location / geocoding files | split | 333 / 333 pass (`dealer-step4-instant-approval` re-run alone after the local server ran out of lock memory, 20 / 20) |
| Whole suite (`npx vitest run`) | single DB | 3016 / 3020 pass |

The 4 whole-suite failures are known and unrelated to this change: `product-import.test.ts`,
`product-import-parser.test.ts`, `pmd-sources.test.ts` (recorded as failing before this change in
TEST_RESULTS_flow_2026-10-30.md) and `migrate-on-build.test.ts` (7 / 7 tests pass alone; only its
clean-up hook times out; this change has no migration).

Changed cases: "Yes" path now validates GSTIN and Shop Act in the window and goes details → review with
no map pin; "upload later" path pays first and the next step after approval is `LOCATION`; a food shop's
FSSAI leads to review. A pin saved on an older draft is still accepted.

## In the browser (local, 390 × 844)

| # | Step | Result |
|---|---|---|
| 1 | `/sell`: one "Register your shop" card, six steps, button → `/shop/register` | Pass |
| 2 | `/shop/join?code=ab12cd34` → `/shop/register?ref=AB12CD34` | Pass |
| 3 | Screen 2: tile board (one checklist), "Enter Referral Code" and "Request Referral Code", 6 documents below | Pass |
| 4 | Email step → "Do you have your documents now?" Yes / No | Pass |
| 5 | Document window: GSTIN, PAN, Shop Act, FSSAI, Udyam in that order, each with Validate | Pass |
| 6 | Validate without consent: button disabled with a hint | Pass |
| 7 | Food shop chosen on details → back to the window, FSSAI "Required", Continue locked until verified | Pass |
| 8 | Confirm details: retrieved shop name, legal name, address, PAN; owner name editable | Pass |
| 9 | Review → "Create my shop and pay" → sandbox "Pay (success)" | Pass |
| 10 | After approval: step 8 "Your shop's address and location", address pre-filled; coordinates + area saved on the shop | Pass |

Found and fixed while testing: the required-code button read "Continue without a code" (now "Enter your
code to continue"); "₹₹999" doubled rupee sign on the fee slab (existing, fixed); Shop Act note repeated
its tag; the no-GST declaration showed before any PAN was typed; owner name missing from the summary
when the GST record names no owner (now "Not in the record — please fill it in below").

Note: the walk-through shop waited for admin approval after payment because the test mobile number
matched a seeded demo shop ("likely duplicate") — the existing duplicate check, as designed.

## Government API validation (mock provider)

| Document | Input | Result |
|---|---|---|
| GSTIN | 27AABCG1234K1ZS | Verified; PAN, shop name, legal name and address filled in |
| PAN | from the GST record | Verified (shown "Taken from your GST record") |
| Shop Act | PMC-SA-2026-1234 | "Our team will check" — online check not available for that state (expected) |
| FSSAI | 12345 | Inline error: exactly 14 digits; no call made |
| FSSAI | 11521998000123 | Verified, valid until 2028-10-29 |

Real-provider checks (Sandbox.co.in / Gridlines) happen on staging, which uses the mock provider
unless `KYC_PROVIDER` is set; not run.

## Google Maps

| Site | Result |
|---|---|
| gokesari.com | Maps JS + Places load with the production key; no error — **Pass** |
| test.gokesari.com | `RefererNotAllowedMapError`: the staging key does not allow test.gokesari.com — **Fail, owner action** (add `https://test.gokesari.com/*` to the key's website restrictions) |
| Local (no key) | Picker shows "Use my current location" and coordinates; saving works — **Pass** |

The fallback for a refused key (`gm_authFailure`) is in the code; it can be seen on staging once
deployed and before the key is fixed.

## Not run yet

- Test server (test.gokesari.com): after PR #298 is merged and `shop_onboarding_wizard_enabled` is on
  for staging — sign in, referral, Yes path with sandbox KYC, pay on the sandbox page, address and pin.
- Prod server (gokesari.com): after an owner-approved release; read-only smoke (one card on /sell,
  `/shop/join` redirect, map loads). No payment on production.
- Real Android / iPhone app run: the apps are WebViews of the site; checked by design, not on a device.

## Known issues and open items

1. Staging Maps key restriction (owner).
2. A shop that pays but waits for admin approval is asked for its map pin only after approval.
3. The address is still entered before payment (the shop needs one when created); page 5 corrects it.
