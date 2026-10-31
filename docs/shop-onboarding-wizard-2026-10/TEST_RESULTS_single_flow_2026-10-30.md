# Test results — shop registration single flow (owner brief, 30 Oct 2026, evening)

Branch `fix/registration-single-flow` (from `staging` at 2afa3104), PR #298 into `staging`.
Design: [FLOW_2026-10-30-b.md](FLOW_2026-10-30-b.md). Tracker: `SHOP_REGISTRATION_SINGLE_FLOW_TRACKER_2026-10-30.xlsx`.

**Where it was tested:** locally (Postgres 18, mock KYC provider, sandbox payment), on both database
layouts, and on **test.gokesari.com** after PR #298 was merged (685e1f2f, live 30 Oct 18:37 UTC) up to
the payment page. **Not** on gokesari.com (the owner chose "staging now, Prod later": production waits
for an approved release window).

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

## On test.gokesari.com (30 Oct 2026, after #298)

Set-up: `shop_onboarding_wizard_enabled` switched on for staging (admin, logged with a reason); a
staging-only referral code `T47BC8PU` (label "QA PR #298", 5 uses) because staging requires a code;
account `customer2` switched to its Customer role for the run and back to Dealer afterwards.

| # | Step | Result |
|---|---|---|
| ST-1 | `/sell` (guest): one card, button → `/shop/register`; no "Quick registration" card | Pass |
| ST-2 | `/shop/join?code=ab12cd34` → `/shop/register?ref=AB12CD34` | Pass |
| ST-3 | Seller Central with no shop: one card | Pass |
| ST-4 | Screen 2: one tile board, Enter / Request Referral Code, 6 documents; button reads "Enter your code to continue" while the code is required | Pass |
| ST-5 | Referral code checked → shop email (account email) → Yes / No → Yes | Pass |
| ST-6 | Document window: GSTIN, PAN, Shop Act, FSSAI, Udyam in order, each Validate shows its result on its line | Pass |
| ST-7 | Confirm details → review: no map step before payment; "Create my shop and pay" creates the shop | Pass |
| ST-8 | Pay. First attempt went to HDFC Bank's UAT gateway (staging was `PAYMENT_GATEWAY=HDFC`). After the owner switched staging to `SANDBOX`, a fresh registration ("QA Staging Full Run 298", account `customer`) opened the built-in sandbox page; "Pay (success)" captured, but **recording failed** (receipt-number bug, below). After #299 (31 Oct 04:01 UTC) the reconcile job recorded it: fee PAID | Pass after fix |
| ST-9 | Paid shop with an unconfirmed GSTIN → "Payment received — pending admin approval" (as designed); approved by the staging admin with a recorded document waiver (QA shop, made-up GSTIN) → step 8 "Your shop's address and location": address pre-filled, **real Google map** with search and "Use my current location"; "Confirm location" saved address, landmark and pin on the shop (18.5167, 73.8415) → step 9 Category | Pass |
| MAP-3 | Maps on test.gokesari.com after the owner's key change | Pass — build carries the production key (…UffY), map and Places load, no `RefererNotAllowedMapError` |

Government checks on staging (provider connected on staging, not the mock): GSTIN (made-up test
number), Shop Act, FSSAI and Udyam all came back "Our team will check" — the provider could not confirm
them (a made-up GSTIN is not in the GST record; FSSAI / Udyam "can't be checked online"). The owner may
carry on, as designed. A real GSTIN / PAN is needed to see "Verified" and the auto-fill on staging.

Found on staging, fixed in the follow-up PR: the "Retrieved from your GST record" box showed when the
check was only in review and nothing was retrieved; the warning box above the window repeated the last
line's message.

Found on staging, not changed: a signed-in user whose active role is **Dealer** sees the wizard but step
1 answers "You do not have permission to perform this action" (dealers lack `SHOP_CREATE`). Existing
behaviour; the page could say "switch to your customer account to register a shop".

Staging data left by the runs: shop "QA Staging Stores 298" (pending, its HDFC checkout never paid) on
`customer2`, which now also holds the Shop Owner role (active role back to Dealer); shop "QA Staging Full
Run 298" (BKS-000037, paid by sandbox, approved with a QA waiver, live) on `customer`; referral code
`T47BC8PU` (2 of 5 uses).

## Bug found on staging and fixed (#299): payment receipt numbers

`nextReference` gave each shop payment the receipt number "row count + 1". Staging had 9 rows
numbered PAY-2026-000004 … 000012 (three deleted earlier), so every new payment tried
PAY-2026-000010, hit the unique index and failed — the gateway took the money but GoKesari never
recorded it, and every retry failed the same way (staging runtime log, 30 Oct 19:13 UTC). Now: highest
number this year + 1, with a test (`shop-payment-reference.test.ts`; payment tests 55 / 55 on both
layouts). **gokesari.com carries the old code**: any production site where a payment row was ever
deleted fails the same way — ship #299 with the next release.

## Not run yet

- Prod server (gokesari.com): after an owner-approved release; read-only smoke (one card on /sell,
  `/shop/join` redirect, map loads). No payment on production.
- Real Android / iPhone app run: the apps are WebViews of the site; checked by design, not on a device.

## Known issues and open items

1. ~~Staging Maps key restriction~~ — fixed 30 Oct by the owner (production key on staging), verified.
2. A shop that pays but waits for admin approval is asked for its map pin only after approval.
3. The address is still entered before payment (the shop needs one when created); page 5 corrects it.
