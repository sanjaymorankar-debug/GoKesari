# Staging full regression after the Neon change: 16-Nov-2026 (IST)

Site: test.gokesari.com. All times are IST.
- **Guest tier:** 10.37 to 10.45.
- **Signed-in tier** (customer, customer2, shop owner, rider, admin, operator, operator-limited) **plus the scenario and local files** (the local ones are recorded "not run here"): 10.45 to 12.54.
- **Re-runs:** 12.56 to 12.57.

Record: `docs/testing/qa-runs/2026-11-16-staging-staging-regression-neon-2026-11-16.json` (label `staging-regression-neon-2026-11-16`, suite commit `aabc8ac4`, the same QA suite as `staging`). Defects: `docs/testing/qa-defects.json`.

What changed before this run:
- Neon compute is now 0.25 to 1 CU and sleeps after 5 minutes idle.
- Old databases, branches and `fdw_old_*` schemas were deleted.
- The staging cron runs every 6 hours.
- PR #392 (P2-D6, registration date in IST) and PR #393 (feature flags cached 15 s, DB pool idle 60 s) were released.

During the run, two docs-only PRs deployed: #394 went live at about 10.41 and #395 at about 11.06. Neither changed `src/`. No #394 deploy happened at 11.30; it had already gone live at 10.41.

## Result

The latest row of each check counts, so the re-runs replace the first try.

| | Pass | Fail | Blocked | Manual | Not run here by rule |
|---|---|---|---|---|---|
| Desktop | 439 | 8 | 86 | 26 | 547 |
| Phone (Pixel 7) | 126 | 6 | 14 | 0 | 24 |
| **Total rows** | **565** | **14** | **100** | **26** | **571** |

First try, before the re-runs: 560 pass and 19 fail. The 5 rows that changed are TC-ORD-013, TC-DEL-004 / TC-FLD-085 and TC-DEL-005 / TC-DEL-006, which all passed when run again at 12.56 to 12.57.

Against 09-Nov (1,277 rows: 463 pass, 105 fail, 137 blocked including 26 manual, 572 not run):
- Pass rose by 102.
- Fail fell from 105 to 14.
- Blocked (not counting manual) fell from 111 to 100.

**No product failure was caused by the database change, the cron change or PRs #392 and #393.** No database symptom appeared anywhere (see "Database health").

### Pass and fail by area (rows, after re-runs)

| Area | Pass | Fail | Blocked | Manual | Not run |
|---|---|---|---|---|---|
| Guest: public pages, access sweeps, security | 106 | 0 | 3 | 2 | 1 |
| Browse and search | 50 | 0 | 10 | 1 | 0 |
| Location and addresses | 32 | 1 | 10 | 0 | 0 |
| Cart and checkout | 40 | 0 | 12 | 0 | 0 |
| Place order, shop accept / reject, dispatch, rider delivery | 71 | 3 | 7 | 0 | 0 |
| Cancel and refund | 19 | 0 | 0 | 0 | 0 |
| Returns and return pickup | 44 | 2 | 0 | 0 | 0 |
| Payments: wallet, online, COD, subscriptions | 34 | 5 | 20 | 0 | 0 |
| Notifications | 10 | 0 | 2 | 2 | 0 |
| Support and disputes | 22 | 0 | 1 | 0 | 0 |
| Admin and operator screens | 90 | 1 | 14 | 16 | 0 |
| Shop catalogue and settings | 18 | 1 | 3 | 4 | 0 |
| Shop onboarding and registration | 2 | 1 | 9 | 0 | 0 |
| Accounts, profile, society, marketing, app install | 26 | 0 | 9 | 0 | 14 |
| End-to-end scenarios | 1 | 0 | 0 | 1 | 36 |
| Local-only files (need the server's database) | 0 | 0 | 0 | 0 | 520 |

### Pass and fail by role (rows of signed-in checks that use the account; one check can use several)

| Role | Pass | Fail | Blocked |
|---|---|---|---|
| Guest (signed out) | 112 | 0 | 3 |
| Customer (gk-lc14) | 357 | 12 | 73 |
| Customer 2 (gk-cust) | 52 | 0 | 16 |
| Shop owner (gk-shop) | 180 | 9 | 26 |
| Rider (gk-rider) | 112 | 4 | 16 |
| Admin (gk-admin) | 42 | 0 | 8 |
| Operator (gk-ops) | 50 | 0 | 12 |
| Operator-limited (gk-oplim) | 3 | 0 | 0 |

All seven staging sessions were still signed in at 10.36, so **no sign-in code was needed and Gmail was not opened**.

## The 14 failed rows (10 checks), sorted

### (a) Caused by today's database or cron change: no product failure

| Check | What happened | Status |
|---|---|---|
| **TC-ORD-013** (desktop, 11.30, first try) | Expected the wallet back at ₹5,284.00; saw ₹5,349.00 (+₹65). The ledger shows the check's own order DB-20261116-Z7UMTE (₹85) was refunded **once**. The extra ₹65 is a different test order, DB-20261116-XVXAPY (placed 10.53, never accepted). The new 6-hour cron line ran at **11.30.02** and its acceptance timeout cancelled and refunded that order once, while this check was measuring. | A timing collision with the 11.30 cron run, not a double refund. **Passed alone at 12.56.** Recorded as E-29. |

### (b) Pre-existing: seen on 09-Nov or caused by data left from it

| Check | Evidence | What it is |
|---|---|---|
| **TC-COD-001 / 002** (desktop and phone), **TC-COD-012** (desktop) | `HTTP 409: You already have 2 cash-on-delivery orders on the way` and the COD radio is disabled. | The same as 09-Nov: two old open COD orders on gk-lc14, beyond the 25 orders the API lists. Test data. |
| **TC-PRE-008** (desktop) | "a packaged product of shop A shows an MRP": MRP is null. | The same as 09-Nov: no product with an MRP. Test data. |
| **TC-FLD-056** (desktop) | No logo upload exists; `logoUrl` is a free URL ("not a url" and "javascript:alert(1)" give 422). | Known feature gap **D-78**, the same as 09-Nov. |
| **TC-RET-010 / TC-FLD-098** (desktop) | The money half passed: bad amounts gave 422, ₹70.50 was stored as 7050 paise, and the wallet rose by ₹70.50. After a reload, page 1 of the shop's "All" returns tab held 5 open cases: 2 from this run plus 3 approved returns left from 09-Nov. The refunded RT-52509C56 was on page 2. | The check only looks at page 1. Not a product fault. Recorded as **E-28**. |
| **TC-CART-018** (phone) | The order card for DB-20261116-RBNHU3 was not found. | The phone check reuses the desktop run's order (11.20) and searches 10 pages of 5 per tab. More than 50 newer orders came before the phone check. A test limit, the same failure as 09-Nov. |
| **TC-FUL-005 / 006** (phone) | Click on "Packed — mark ready" timed out. The "Get the GoKesari app" bottom sheet covered the button, even with the page scrolled to the end. Screenshot: `test-results/qa/artifacts/test.gokesari.com/signed-in-orders-fulfil-TC-49423-EADY-and-a-rider-is-offered-mobile/test-failed-2.png` | Also failed on the phone on 09-Nov (not traced then). The sheet comes back on every page load until the app is installed. Newly logged as **D-149** (Low, needs your decision). |
| **TC-LOC-008** (phone) | "Yes, delete" stays "outside of the viewport" for 30 s. The inline confirmation runs past the right edge of the address card, and the site clips sideways scrolling. Screenshot: `test-results/qa/artifacts/test.gokesari.com/signed-in-shopping-locatio-a6f23-d-one-is-gone-from-the-cart-mobile/test-failed-2.png` | Also failed on the phone on 09-Nov, when it was filed as a test problem. It is a product layout fault: **a customer on a phone cannot delete a saved address.** Newly logged as **D-148** (Medium). |
| **TC-DEL-004 / TC-FLD-085, TC-DEL-005 / 006** (desktop, 11.32 to 11.33, first try) | 1. Two "Confirm pickup" buttons (both correctly disabled) caused a strict-mode error. 2. The customer's full address was on the rider screen before pickup. Both came from **return pickup RT-82EEF80E**, left "on the way to the customer" since 09-Nov 20.31. Its card has its own "Confirm pickup" and "Collect from: E2E Lifecycle Test, 12 FC Road". | Data left from 09-Nov. Closed at 11.35 (rider "could not collect"). **All passed on the phone (12.3x) and on the desktop re-run (12.56 to 12.57).** Recorded as **E-26**. This is most likely also the cause of 09-Nov's one unexplained phone failure (TC-DEL-004 / TC-FLD-085). |

### (c) Timing flakes

None apart from TC-ORD-013 above.
- No failure came from the 15-second feature-flag cache (PR #393). This run switched no flag.
- No failure came from a slow first request.

### (d) New product defects

**None caused by today's changes.** The two product defects logged today, D-148 and D-149, are older faults that this run traced for the first time.

### Not a product failure: a check that is out of date

| Check | Evidence | What it is |
|---|---|---|
| **SD-06** (desktop, new since 09-Nov) | `/shop/register` for gk-shop shows "QA Docs 2026-10-29 mw273ehr is already waiting for approval … you can add another shop after that." and "Go to my shop", not the wizard tiles. | Since **P2-D3** (09-Nov 21.49, after the 09-Nov run), an account with a shop waiting for approval is told so instead of getting the wizard. The check predates that change and needs updating. Recorded as **E-27**. |

## Payments (Cashfree sandbox only)

- **Wallet top-up.** At 10.37 the customer started a top-up of ₹5,000 (`cashfreeMode: sandbox`). The "Sandbox payment" workflow (run 43808200656) paid it with UPI `upi-success` (testsuccess@gocash). The webhook credited the wallet: ₹999 became ₹5,999 at 10.39. `/api/wallet/verify` then answered `alreadyProcessed: true` with no second credit.
- **Online order payment.** The customer reopened payment on a pending online test order, DB-20261116-6ZDIFA (₹55), at 12.58. The workflow (run 43824101253) paid it with UPI success. By 12.59.42 the payment was `CAPTURED` and the order `CONFIRMED`.
  - I then cancelled it at 13.00.54. It became `REFUND_PENDING`, and the ₹55 refund went to Cashfree at once (`PROCESSING` at 13.00.58).
  - The refund's final "completed" state comes from Cashfree's webhook or the payments-reconcile cron. That step is **limited by the 6-hour staging cron**; the next run is at 17.30.
- **In the suite**, TC-PAY-002/004/017/018/019/020/021/024/028/029/033 stay "blocked: needs the Sandbox payment workflow", as on 09-Nov. The two payments above were run by hand and are evidence for TC-PAY-002 and TC-PAY-017; they are not suite rows.
- **The shop registration-fee sandbox page** (`/orders/pay/sandbox/…`) was not reached. SD-01 to SD-07 are blocked because gk-shop's 29-Oct QA shop is still waiting for approval, and only one registration is allowed at a time.
- **P2-D6 (#392, registration date in IST) was not exercised by this run**, for the same reason: no new shop could be registered.
- No real card, UPI ID or bank account was used.

## Database health (Neon 0.25 to 1 CU, sleep after 5 minutes, old databases removed)

- **No database symptom anywhere.** I searched every result row and the run logs for:
  - "relation … does not exist" or "database … does not exist";
  - connection errors (ECONNRESET, ETIMEDOUT, terminated, too many connections);
  - 500, 502, 503 or 504 answers.

  There were no hits. Every match for "500" was text such as "500 characters".
- **Checks that cover it all passed:**
  - TC-PRE-002, guest and signed in ("database-backed pages load without a 500");
  - TC-RBAC-002 (213 signed-in pages refuse a guest);
  - TC-SEC-001 (400 write endpoints refuse a guest);
  - TC-SEC-002 and TC-DISC-007 / TC-DISC-012 (odd ids and text never give a 500);
  - every order, wallet, return, notification, admin and operator check that passed.
- **Site watch:** 142 samples, one a minute from 10.40 to 13.02. All answered 200, the slowest in 0.19 s. The two docs deploys caused no errors.
- **Cold start:** after about 6 quiet minutes, the first database-backed request (13.07, `GET /api/wallet`) took **2.0 s**, then 1.1 s and 0.6 s. That fits the expected 1 to 3 s first request, once.
- **6-hour cron:** the 11.30 run did its work. It timed out the unaccepted test order XVXAPY and refunded it once (see TC-ORD-013).
  - The other unaccepted test order, DB-20261116-N8B5MT ("Accept by 11:33"), is still "New" and waits for the 17.30 run.
  - No suite check on staging calls a cron job: those checks are local-tier and recorded "not run here". I did not have the staging `CRON_SECRET`.

## Compared with 09-Nov

| | Checks |
|---|---|
| **Fixed or now passing** | 86 of the 99 (case, device) pairs that failed on 09-Nov no longer fail. 71 now pass and 12 are now blocked by test data (shop B, Places, host firewall). This includes:<br>- the 41 checks that were "fixed but not re-tested" on 09-Nov (TC-RET-*, TC-DEL-004/005/006/020, TC-CART-011/012/017, TC-SEC-004/005, TC-SPI-006/008, TC-SUP-008, TC-SUB-001, TC-LOC-004/023, TC-DISC-013, TC-ORD-012, SC-GW);<br>- 16 phone returns checks that were blocked on 09-Nov. |
| **D-147** ("Packed — mark ready" active while the customer decides) | **Re-test passed** on desktop (11.42) and phone (12.37): the button is disabled, READY gives 409, and approval refunds ₹20 at once. Marked "Fixed - retest passed". |
| **09-Nov's unexplained phone failure** (TC-DEL-004 / TC-FLD-085) | **Explained and passing.** It was the left-over return pickup (E-26). |
| **Same as 09-Nov** | COD (two old open orders), TC-PRE-008 (no MRP), TC-FLD-056 (D-78), TC-RET-010 / TC-FLD-098 (now traced to page 1 only, E-28), TC-CART-018 phone, TC-FUL-005/006 phone (now traced: D-149), TC-LOC-008 phone (now traced: D-148). |
| **New** | SD-06 (check out of date after P2-D3, E-27). TC-ORD-013 (cron collision, passed on re-run). |

## Blocked rows (100, plus 26 manual)

| Why | Rows |
|---|---|
| No rider2 / shopB session. Their account (firstshop.gokesari@gmail.com) is outside the approved Gmail addresses, so I did not read its codes. | 23 |
| Other test data missing on staging: customer2 without a mobile, loose and unpriced listings, shop C, address ids | 14 |
| Online payment needs the Sandbox payment workflow (see Payments) | 13 |
| No verified society or society account | 11 |
| Shop B (Asmy test2) not taking orders or not delivering here | 10 |
| The QA shop of 29-Oct still waiting for approval (SD-01 to SD-07) | 8 |
| COD limit: two old open COD orders on gk-lc14 | 8 |
| Host firewall 403 on the `<script>` search (E-01) | 3 |
| No SMS / WhatsApp provider | 3 |
| No plain customer without a shop (TC-RBAC-003 half, RB-02) | 2 |
| Needs live Google Places | 2 |
| No delivery offer reached the rider in 20 s (TC-FUL-005/006 desktop, 11.42). The rider was busy with a delivery then. | 2 |
| Nothing to check: D-02 is already fixed | 1 |

## What needs you

| Item | Unblocks |
|---|---|
| **D-148** (Medium): a phone user cannot delete a saved address. Suggested fix: let the address card's action row wrap on narrow screens. It is for a developer; this run did not change product code. | TC-LOC-008 phone |
| **D-149** (Low): decide whether the install sheet should leave room at the bottom of the page, or show less often in Seller Central. | TC-FUL-005/006 phone |
| Approve or reject the 29-Oct QA shop "QA Docs 2026-10-29 mw273ehr" (the QA agent does not approve on staging) | SD-01 to SD-07, the registration-fee sandbox page, a P2-D6 check, SD-06 |
| Close the two old open COD orders on gk-lc14 | 8 blocked and 5 failed COD rows |
| A session for firstshop.gokesari@gmail.com (rider2 / shop B), or permission to read its codes | 23 blocked rows |
| Shop B: wallet, delivery and hours; a verified society; a customer with no shop; customer2 without a mobile; a product with an MRP | about 40 blocked rows |
| Suite updates (test code; not changed today because this run was not to commit):<br>- SD-06 for P2-D3;<br>- TC-RET-010 to search every page;<br>- TC-CART-018 phone to search deeper;<br>- phone checks to tap "Not now" on the install sheet;<br>- the returns file to close its pickups at the end. | SD-06, TC-RET-010, TC-CART-018 |
| Old test data on the bakery: 88 open orders (1 new, 8 packing, 79 ready / assigned) and 3 approved 09-Nov returns waiting for pickup | Fewer side effects between checks |
| Top up the gk-lc14 wallet again before the next run. It stood at ₹364.50 at 13.10; this run spent about ₹5,635, and no check was blocked for money this time. A sandbox top-up through the workflow works, as done at 10.37. | The next full run |

## What was changed on test.gokesari.com

| When (IST) | Change |
|---|---|
| 10.36 | Sign-in tool run. All 7 sessions were still valid. It also requested codes for rider2 and shopB (firstshop.gokesari@gmail.com). Those were **not read** and the tool was stopped. |
| 10.37 to 10.39 | Customer gk-lc14 wallet topped up by ₹5,000 with Cashfree sandbox UPI through the "Sandbox payment" workflow (₹999 → ₹5,999). |
| 10.41 to 13.01 | The suite set gk-rider Ready with an admin override of the KYC gate. **Removed at 13.01: rider offline, override off.** |
| 11.35 | Left-over 09-Nov return pickup RT-82EEF80E closed as "could not collect"; the return is back to APPROVED. |
| 12.58 to 13.00 | Pending online test order DB-20261116-6ZDIFA paid in the Cashfree sandbox (₹55), then cancelled by the customer. The ₹55 refund is with the gateway. |

Customer gk-lc14's active role is CUSTOMER, as before. No business rule, `/admin/settings` value or feature flag was changed. Nothing was approved, rejected or suspended.

The master register and `test-cases.xlsx` were not rebuilt in this run.
