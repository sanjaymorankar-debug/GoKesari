# Staging test: referrals, dealer commission, payouts and TDS (PR #327)

03-Nov-2026, 07.58 IST · test.gokesari.com · build of `staging` at b0fcd7de (PR #327 merged 06.47 IST)
Run file: [docs/testing/qa-runs/2026-11-03-staging-dealer-tiered-flags-on.json](../testing/qa-runs/2026-11-03-staging-dealer-tiered-flags-on.json) ·
Register: [docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx](../testing/GOKESARI_MASTER_TEST_REGISTER.xlsx) · Defects: [docs/testing/qa-defects.json](../testing/qa-defects.json) (E-18, E-19 new)

## Result in one line

**No defect in the new features and no regression they caused.** Every failure is staging test data,
check order or the host's rate limit, and all of them are known or explained below.

## 1. Database (migrations 0136–0142)

The test database had just lost its FDW link to the seller database (02-Nov 23.40 IST). After that
move the seller tables live in the site's own database, and the migrator uses the ordinary
one-database path.

| Step | Result |
|---|---|
| Dry run on a Neon branch of the test database (`dryrun-0136-0142-2026-11-03`) | 7 migrations in 12 s; 11 new tables, CA role, 2 TDS rows; the 4 team members each got a history row; all 6 dealers stayed STANDARD; 0 invalid constraints |
| Rollbacks 0142 → 0136 on the same branch, then migrate again | All ran; re-applied cleanly |
| "Test database" workflow on the merge (run 41558715854) | Backup `gokesari_test_2026-11-03_0117_run94.dump` (11 MB, 14 days), then **7 migrations applied, 151 recorded**; verify passed |
| Live check | 11 new tables, 6/6 dealers STANDARD, 0 invalid constraints, 0 foreign tables (the FDW removal is untouched) |
| Code | Merged `staging` (D-121) cleanly; typecheck clean; 162/162 of the new and affected tests on both layouts locally |

## 2. Rules switched on for the test (test.gokesari.com only)

`dealerTieredCommission` on · `shopReferrals` on · `dealerAutoPayout` on (SANDBOX) · `dealerPayoutTds` on.
`customerReferrals` was already on. `dealerPayouts` left at its defaults (payee checks for dealers
off, minimum ₹0), because they wait for the owner's decision 6. Production: every rule stays off.

## 3. Totals (996 checks; desktop and phone)

| Tier | Pass | Fail | Blocked | Skipped |
|---|---|---|---|---|
| Guest (desktop + phone) | 105 | **0** | 6 | 1 |
| Signed-in (desktop + phone) | 162 | 55 | 381 | 14 |
| Scenarios | 0 | 1 | 1 | 36 |
| **All** | **267** | **56** | **388** | **51** |

Before this release (02-Nov, same site) the guest tier had 5 fails. Most blocked checks are the
usual staging preconditions: no stock or rider online, accounts at the COD limit, a low wallet
balance (E-16).

## 4. The new cases

| Case | Result | What was seen |
|---|---|---|
| TC-TIER-011 | Pass (desktop, phone) | TIERED model settings shown on the admin screen with the rule on |
| TC-TIER-001 | Pass | a lead placed under a lead is refused (404); an operator cannot change the model (403) |
| TC-SREF-006 | Pass | Admin → Shop-refers-shop rewards opens ("no referrals yet") |
| TC-SREF-002 | Pass | `/r/SHOPAB2CD` → 307 `/shop/register?ref=SHOPAB2CD` |
| TC-SREF-007, TC-DPAY-005 | Pass | every new dealer, team, shop-referral, payout-report and TDS API refuses a signed-out caller (401) |
| TC-DPAY-004 | Pass | payout reports (summary, lines, pending, failed) in CSV and XLSX; operator read-only |
| TC-TDS-003 | Pass (desktop, phone) | TDS rows shown with their section, mode and "not confirmed" |
| TC-SREF-001, TC-SREF-003 | Blocked in the run → **passed by hand** | the shop account's active shop is the one still waiting for approval, which has no code by design (E-18). With the approved shop A active: code `SHOPVH3YP`, its `/r/` link and WhatsApp share are shown; `/r/SHOPVH3YP` → `/shop/register?ref=SHOPVH3YP`; the code check accepts `SHOPVH3YP` and refuses `SHOPZZZZZ` |
| TC-TIER-002…010, TC-SREF-004/005, TC-DPAY-001…003, TC-TDS-001/002 | Not automated on a site | they need a whole dealer network with paid shops and delivered orders, or a CA account; each amount and rule is proven by the unit and integration tests (78) that pass on both database layouts |

## 5. Failures that passed on 02-Nov (6), all explained

| Case | Why | Next |
|---|---|---|
| TC-RBAC-018, TC-APP-008 | the app's rate limiter answered 429 during the burst | re-run one by one: **both pass** |
| TC-SEC-004, TC-SEC-005 | re-run: stop at checkout 402, the customer wallet is low (E-16) | top up the staging test wallet |
| TC-UX-002 (desktop, phone) | wallet ₹25 < order ₹85, so the page shows "Add money to wallet" instead of the pay button (E-16) | same |
| TC-DISC-004/005 | a shop-settings check in this run re-saved shop A with area "Deccan" (pincode 411005), so the search for "Kothrud" no longer finds it (E-19) | restore the area; make the check read shop A's area |

The other 46 fails failed on 02-Nov too, or were blocked then and now reach the same low-wallet
402 (checkouts, COD limit, scheduled-slot buttons, SD-01's pending QA shop, the customer test
account that now also holds the SHOP_OWNER role for TC-RBAC-002/003/012 and TC-SEC-001). None of
them touches the new code.

## 6. Not done here

* Production: released after this run in PR #332 (merged 03-Nov-2026 09.06 IST; Post-deploy check
  run 41573270937 passed). Migrations 0136–0142 were applied to production before it ("Production
  database" run 41566797127, two-database layout, 143 recorded). Every new rule is off there, and
  `dealer_programme_enabled` is off, so the dealer pages and APIs answer 404 on gokesari.com.
* Since 11.33 IST `dealer_programme_enabled` is on for all of India on test.gokesari.com (was KA + MH-PUN).
* App 1.7.0 store builds: need the owner's Expo account.
* Owner decisions 1–9 and the CA items listed in [OWNER_GUIDE.md](../referrals-dealer-2026-11/OWNER_GUIDE.md).
