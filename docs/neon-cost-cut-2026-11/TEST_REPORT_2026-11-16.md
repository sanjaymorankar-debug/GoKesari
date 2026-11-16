# GoKesari: test report after the Neon cost cut, 16-Nov-2026

**Written:** 16-Nov-2026, 13.27 IST; production release result added 15.15 IST. **Times:** IST (UTC + 5:30).
**Scope:** gokesari.com (production) and test.gokesari.com (staging). The bkesari sites are not part of this chat and were not tested here.
**What changed today:** the Neon database settings and clean-up (see `GOKESARI_NEON_COST_CUT_REPORT_2026-11-16.md`), plus PRs #392 (shop registration date in IST) and #393 (15-s feature-flag cache, 60-s pool idle time, staging cron every 6 h).

## Result

**Nothing broke because of today's changes on either site.**
- No database errors anywhere: no "relation / database does not exist", no connection errors, and no 500, 502, 503 or 504.
- No failure is a new product defect caused by today's work.

| Site | Run (IST) | Pass | Fail | Blocked | Manual | Skipped |
|---|---|---|---|---|---|---|
| **Production** (guest tier, read-only; owner's rule: no orders on production) | 07.10-07.21 | 75 tests (104 case rows) | 1 test (2 case rows), already failing on 04-Nov | 3 case rows (host firewall, known E-01) | 0 | 54 (desktop-only checks on phone; 3 not run on production by rule) |
| **Staging** (full regression: guest + 7 signed-in accounts, orders, sandbox payments) | 10.37-12.57 | **565** | 14 (none from today's changes) | 100 (test data) | 26 | 571 (not run on staging by rule) |
| Staging, 09-Nov (for comparison) | | 463 | 105 | 111 | 26 | 572 |

## Smoke checks

`scripts/release/post-deploy-check.sh` passed 5/5 on both sites after each setting change: 06.26, 06.40, 06.53, 08.51 and 08.55.

## Production (gokesari.com): read-only, per flow

| Flow | Result |
|---|---|
| Home, shops, categories, filters, location by PIN, legal pages, 404 | PASS, desktop and phone, no console errors |
| Shop pages, product pages | PASS |
| Search | PASS. 1 check blocked: the host firewall answers 403 to a `<script>` search (known E-01, same on 04-Nov) |
| Cart (guest view) | PASS: sent to sign-in, nothing added |
| Sign-in pages, all four roles | PASS: code button gated on terms, bad input refused, secure cookie |
| Notifications (guest view) | PASS: 401 / redirect |
| Cron endpoints | PASS: all 26 refuse calls without a token or with a wrong one |
| Admin access | PASS for 219 pages and the read APIs. **1 FAIL:** `POST /api/admin/support-services` answers 404 instead of 401 to a guest, because a setting check runs before the sign-in check. Nothing leaks and nothing is written. It already failed on 04-Nov. |
| Cron running (runtime log 07.59-08.58) | PASS: 59 every-minute runs, payments reconcile every 5 min, 1 hourly run, 0 errors |

**Not run on production, by the owner's rule:** orders, payments, sign-in with codes, and the signed-in tier.

## Staging (test.gokesari.com): full regression, by area

| Area | Pass | Fail | Blocked | Manual |
|---|---|---|---|---|
| Guest | 106 | 0 | 3 | 2 |
| Browse and search | 50 | 0 | 10 | 1 |
| Location and addresses | 32 | 1 | 10 | 0 |
| Cart and checkout | 40 | 0 | 12 | 0 |
| Place order, accept / reject, dispatch, delivery | 71 | 3 | 7 | 0 |
| Cancel and refund | 19 | 0 | 0 | 0 |
| Returns and return pickup | 44 | 2 | 0 | 0 |
| Payments (Cashfree sandbox) | 34 | 5 | 20 | 0 |
| Notifications | 10 | 0 | 2 | 2 |
| Support | 22 | 0 | 1 | 0 |
| Admin and operator screens | 90 | 1 | 14 | 16 |
| Shop catalogue and settings | 18 | 1 | 3 | 4 |
| Shop onboarding and registration | 2 | 1 | 9 | 0 |
| Accounts, profile, society, marketing | 26 | 0 | 9 | 0 |

**By role (pass / fail / blocked):**
- Customer 357 / 12 / 73
- Customer2 52 / 0 / 16
- Shop owner 180 / 9 / 26
- Rider 112 / 4 / 16
- Admin 42 / 0 / 8
- Operator 50 / 0 / 12
- Operator-limited 3 / 0 / 0

**Sandbox payments:**
- Wallet top-up of ₹5,000 by UPI: credited once.
- Online order paid by UPI: confirmed, then cancelled. The ₹55 refund went to Cashfree. Its final status waits for the webhook or the 17.30 staging cron.

### The 14 failures, sorted

| Kind | Checks | Why |
|---|---|---|
| **Today's change (cron timing), not a product fault** | TC-ORD-013 | The 6-hourly cron ran at 11.30 during the check. It correctly timed out and refunded a *different* unaccepted test order, so the wallet total moved. Passed alone at 12.56. Logged E-29. |
| Old test data | TC-COD-001/002 (desktop and phone), TC-COD-012 | Two old cash-on-delivery orders still open (same as 09-Nov) |
| Old test data | TC-PRE-008 | No packaged product with an MRP |
| Known gap | TC-FLD-056 | No logo upload (D-78) |
| Test limit | TC-RET-010 / TC-FLD-098 | The refund itself passed; the check only reads page 1 of the returns list (E-28) |
| Test limit | TC-CART-018 (phone) | Searches only 50 orders back |
| Older phone layout fault, newly logged | TC-FUL-005/006 (phone) | The "Get the GoKesari app" sheet covers "Packed — mark ready". **D-149**, Low, owner decision |
| Older phone layout fault, newly logged | TC-LOC-008 (phone) | A customer on a phone can't delete a saved address: the "Yes, delete" button sits off-screen. **D-148**, Medium, needs a fix |
| Old test data, fixed during the run | TC-DEL-004/005/006, TC-FLD-085 | A return pickup left open from 09-Nov. Closed at 11.35; all passed on re-run |

**Timing flakes from the 15-s flag cache:** none. **Cold start after staging sleeps:** the first request after about 6 quiet minutes took 2.0 s, then 1.1 s and 0.6 s. That is expected.

**Compared with 09-Nov:**
- 86 of the 99 failures then no longer fail: 71 now pass and 12 are blocked by test data.
- D-147 re-test passed.
- One check is out of date (SD-06, after the 09-Nov P2-D3 change). Logged E-27.

## CI on the production release (#396)

- **CI result:** 3,463 of 3,464 integration tests passed.
- **The one failure:** TC-B26-E-040 (fee invoice numbering).
  - The test expects the first shop to get invoice 000001.
  - The payout cycle takes shops in the order the database returns them, and that order isn't fixed.
  - Today's code doesn't touch invoicing.
- **Re-run:** CI ran again on the final release head (`14d00f15`, which adds the docs-only #398) and passed in full at 14.53 IST, with TC-B26-E-040 included. A permanent fix to that test (sort the shops, or look the invoice up by shop) is still worth a small PR.
- **Released:** #396 was merged into `main` at 15.00 IST. Hostinger's build finished at 15.06.
- **Post-deploy check:** passed. The workflow ran 15.00-15.07, then 5/5 on the new build (15.08-15.12). The every-minute cron ran with no errors.

## Needs the owner (from the staging run)

1. A developer fix for **D-148** (phone: can't delete a saved address).
2. A decision on **D-149** (the app-install sheet covers the shop's "mark ready" button on phones).
3. Approve or reject the 29-Oct QA shop that is waiting for approval. It blocks the registration-fee test and #392's date check on staging.
4. Close the two old open cash-on-delivery orders on staging.
5. Customer gk-lc14's staging wallet is down to ₹364.50; top it up (sandbox) before the next run.

## Files

- Staging run detail: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/TEST_RESULTS_staging-regression-neon_2026-11-16.md`
- Staging run record: `docs/testing/qa-runs/2026-11-16-staging-staging-regression-neon-2026-11-16.json`
- Defect log: `docs/testing/qa-defects.json` (D-148, D-149 and E-26 to E-29 added)
- Production run output: `test-results/qa/gokesari.com/` (git-ignored)
