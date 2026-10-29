# Onboarding wizard step 2 — test results (28 Oct 2026)

Branch `claude/onboarding-wizard-step2-b1ade0`, based on staging after step 1 (PR #267).
Migration 0113 (renumbered from 0112: staging took 0112 for "More licences"). Local PostgreSQL 18 (Postgres.app), built-in mock KYC
vendor, sandbox payment gateway (in-process — no Cashfree call). Run by Claude.

## New tests — `tests/integration/onboarding-wizard-step2.test.ts`

| Layout | Result |
|---|---|
| One database | **22 / 22 passed** |
| Two databases (seller tables through postgres_fdw) | **22 / 22 passed** |

Step 1, instant approval (dealer step 4) and onboarding-stage tests run alongside: 69 / 69 on the
two-database layout, 48 / 48 on one database.

| # | Case | Result |
|---|---|---|
| 1 | GSTIN → details (pre-filled from the GST record) → Udyam → FSSAI "no" → Shop Act → map → review; every answer names the step to resume at; a new session resumes at the same step | Pass |
| 2 | A later step before the GSTIN/PAN step is done → refused; GSTIN not found → cannot go on; payment before every step → 409 `STEP_OPEN`, no shop created | Pass |
| 3 | Map pin outside India → refused | Pass |
| 4 | Udyam not found → FAILED with message, stays on the step | Pass |
| 5 | FSSAI expired → EXPIRED, cannot continue | Pass |
| 6 | Vendor down → PENDING, may continue; a repeat within 30 s pays nothing | Pass |
| 7 | Verified number submitted again → stored result, no second paid call | Pass |
| 8 | Malformed number / no consent → refused, no vendor call | Pass |
| 9 | Shop Act the source can check → VERIFIED (no admin review listed) | Pass |
| 10 | Numbers stored only as ciphertext + masked; audit masked (first run caught the typed Shop Act form stored in clear — fixed: kept as ciphertext) | Pass |
| 11 | Food shop (dairy): FSSAI answered yes automatically, "no" refused, payment refused until FSSAI | Pass |
| 12 | General shop answered FSSAI "no", then switched to bakery → sent back to FSSAI | Pass |
| 13 | Dairy with verified FSSAI → live after payment; FSSAI number and Shop Act number (as typed) on the shop | Pass |
| 14 | Dairy whose FSSAI check is still pending → paid, **not** live (`WAITING`), log names FSSAI | Pass |
| 15 | Draft → shop: GSTIN, PAN, Udyam, FSSAI, Shop Act copied to `seller_verifications` with provider id / ref, consent and `source: ONBOARDING_WIZARD`; GST written through to the shop; stage PAYMENT_PENDING (Shop Act in review does not hold it); double submit → same shop. Sandbox payment → **APPROVED with the district flag off** (decision B), lifecycle ACTIVE, log evidence `documentsInReviewAfterApproval: [SHOP_ACT]`, draft COMPLETED, "Registration successful" notice queued, Shop Act still MANUAL_REVIEW | Pass |
| 16 | Two taps at once (two tabs) → one shop, both answered with the payment step | Pass |
| 17 | No-GSTIN route: PAN + declaration → declaration row MANUAL_REVIEW, shop `NOT_REGISTERED`, GSTIN + Shop Act listed for review → live after payment | Pass |
| 18 | No-GSTIN route, PAN name ≠ owner / shop name → PAN to review, paid but not live | Pass |
| 19 | Failed payment → pending, wizard at PAYMENT; retry succeeds → live | Pass |
| 20 | Shop Act licence registered meanwhile by another owner → refused, nothing created, draft still OPEN | Pass |
| 21 | A shop registered outside the wizard keeps today's rule: Shop Act in review + flag off → paid but KYC_PENDING, not live | Pass |
| 22 | HTTP routes: signed-out 401; GET resumes; documents "no" / no consent (422) / check; numbers never in responses; early submit 409 | Pass |

## Screen check (local dev server, phone width 375 px)

GSTIN step, shop details pre-filled from the GST record, Shop Act step, map step (fallback to
coordinates when Maps is not configured), review with masked numbers and status badges, and the
payment step (shop created, Shop ID, "Pay ₹1,178.82 now") were checked in the browser. Fixed after the
check: a "we'll keep checking / our team will check" message now stays on screen when the wizard moves
on to the next step, and the payment step's wording matches where the gateway returns the owner.

## Full suite

| Layout | Passed | Failed | Notes |
|---|---|---|---|
| One database | 2,874 | 3 tests + 2 file hooks | All pre-existing (same as on unchanged staging, step-1 report) |
| Two databases | 2,864 (8 skipped) | 6 tests | 3 pre-existing (as below); 2 were this branch's — the feature-flag list test did not know the new `shop_onboarding_wizard_enabled` flag (test updated, now passes on both layouts); 1 was local PostgreSQL "out of shared memory" while a second suite ran on the same server (`seller-verification-flows`, passes on both layouts when re-run) |

Pre-existing failures, none from this change:

- `migrate-on-build` and `split-migrate`: every test passes — including rolling back through 0113 and
  re-applying it — but the clean-up hook (dropping the scratch database) times out on local PostgreSQL 18.
- `product-import-parser` and `product-import` (`PUZZLES.xlsm`): the empty row is not counted as skipped.
- `pmd-sources` streaming .xlsx reader: intermittent.

Re-run after the fixes, both layouts: `onboarding-wizard-step2`, `seller-verification-flows`,
`dealer-step1-flags-geo` — 52 / 52 each.

CI (`test` and `test-split` jobs) runs on its own PostgreSQL and is the deciding check once the branch is pushed.

## 29 Oct 2026 — `?wizard=1` gated by the flag (branch `claude/wizard-link-gate`)

Before: `/shop/register?wizard=1` opened the wizard for anyone, even with `shop_onboarding_wizard_enabled`
off, so a shared link could create a shop that goes live straight after payment (decision B) before
the lawyer/CA sign-off. Now the page and the wizard's routes (details, documents, location, submit)
follow the flag; while it is off only an admin can use the wizard.

| Case | One database | Two databases |
|---|---|---|
| Flag off, not an admin: `?wizard=1` → long form; details / documents / location / submit → 404 `FEATURE_NOT_AVAILABLE`, nothing saved, no shop | Pass | Pass |
| Flag off, an admin: `?wizard=1` → wizard (without it, or with `?form=1`, the long form); steps work | Pass | Pass |
| Flag on: everyone gets the wizard, `?form=1` still the long form; steps work | Pass | Pass |

`onboarding-wizard-step2` (now 25 tests), `onboarding-wizard-step1`, `dealer-step1-flags-geo`: **58 / 58 on each layout**.

## Not covered here

- A real Cashfree sandbox payment on test.gokesari.com (the "Sandbox payment" workflow) — after the
  owner merges into staging and switches `shop_onboarding_wizard_enabled` on there.
- Google Maps pin picking (no Maps key locally); the coordinate fallback was used.
