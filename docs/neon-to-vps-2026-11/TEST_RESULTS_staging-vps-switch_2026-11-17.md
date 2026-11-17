# Staging QA after the switch to our own database server: 17-Nov-2026 (IST)

Plan step **S11** of [PLAN.md](PLAN.md). Site: **test.gokesari.com only**; nothing was run against gokesari.com. All times are IST.

test.gokesari.com moved from Neon to GoKesari's own PostgreSQL server at **05.52**. Writes opened at **05.54**. Staging's every-minute cron runs every minute again from **05.56**.

Record: `docs/testing/qa-runs/2026-11-17-staging-staging-vps-switch-2026-11-17.json` (label `staging-vps-switch-2026-11-17`, QA suite of `staging` d3e907b4). Defects: `docs/testing/qa-defects.json` (E-30 to E-35 added). Register rebuilt: `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx`, statuses written to `test-cases.xlsx`. Evidence: [staging-vps-switch-2026-11-17/](staging-vps-switch-2026-11-17/).

## Verdict

**No failure was caused by the database move.**
- The final result matches the 16-Nov Neon baseline almost row for row: **565 pass**, 12 fail (14 on 16-Nov), 102 blocked (100), 26 manual and 571 not run here by rule.
- All 12 remaining failures are known from 16-Nov or earlier. Each is test data, a test limit or an open product defect.
- No result row and no run log shows a 5xx answer, a database error, a connection error or a timeout from the site.
- **Reads and writes** work on the new server. That covers orders, wallet debits and refunds, returns, support tickets, purchase lists, profile and address writes, a new shop and its fee, and the admin and operator screens.
- **Both Cashfree sandbox payments** were confirmed by Cashfree's webhook on the new database within about 30 s.
- **The every-minute cron is running and writing.** It handles acceptance timeouts, payment expiry and notification retries.

## Timeline

| Time | What |
|---|---|
| 06.00 | All 7 saved staging sessions still signed in (no sign-in code needed, Gmail not opened) |
| 06.03–06.11 | Guest tier |
| 06.04–06.06 | Cashfree sandbox payment 1: ₹10 wallet top-up (see Payments) |
| 06.08–06.11 | Shop registration fee: new wizard shop, fee paid through the Cashfree sandbox, shop live |
| 06.12–06.56 | Signed tier, attempt 1. **Not valid:** gk-lc14's wallet held only ₹439.50 and ran out (E-33) |
| 06.57–06.59 | ₹5,000 sandbox top-up for test funds |
| 06.58–08.02 | Signed tier, attempt 2 (signed-in, scenarios and the local files, which are recorded "not run here") |
| 07.59.27, 08.15.46 | This Mac lost its network for a few seconds (E-31) |
| 08.04–08.06 | Restocked 3 bakery listings to 100; ₹5,000 sandbox top-up |
| 08.06–08.19 | Re-run 1 of the affected files. Spoiled by the rider being left busy by the 07.59 drop (E-32) |
| 08.21–08.22 | Leftover delivery finished; 9 leftover test orders cancelled |
| 08.22–08.39 | Re-run 2 of the affected files: clean |
| 08.40 | TC-FUL-005/006 phone re-run once |
| 06.13–08.38 | Site watch: one uncached database search and one home page a minute (145 samples) |

## Result (latest row per check)

| Tier | Pass | Fail | Blocked | Manual | Not run here by rule |
|---|---|---|---|---|---|
| Guest | 112 | 0 | 3 | — | — |
| Signed in | 453 | 12 | 99 | 26 | — |
| Local (needs the server's database) | — | — | — | — | 571 |
| **Total rows** | **565** | **12** | **102** | **26** | **571** |

| Device | Pass | Fail | Blocked | Manual | Not run |
|---|---|---|---|---|---|
| Desktop | 439 | 8 | 86 | 26 | 547 |
| Phone (Pixel 7) | 126 | 4 | 16 | 0 | 24 |

Against 16-Nov (Neon, 565 / 14 / 100 / 26 / 571), only 2 rows changed: TC-FUL-005/006 on the phone went from fail to blocked (E-35). Every other row has the same status.

### The 12 failed rows: all known, none from the database move

| Check | Evidence | Known as |
|---|---|---|
| TC-COD-001 (desktop, phone), TC-COD-002 (desktop, phone), TC-COD-012 (desktop) | "You already have 2 cash-on-delivery orders on the way"; the COD option is disabled | Same as 09-Nov and 16-Nov: two old open COD orders on gk-lc14 (test data) |
| TC-PRE-008 (desktop) | "a packaged product of shop A shows an MRP": null | Same as 09-Nov and 16-Nov: no product with an MRP (test data) |
| TC-RET-010 / TC-FLD-098 (desktop) | The refunded return RT-7E55B46E is not on page 1 of the shop's returns tab | E-28 (the check reads page 1 only) |
| TC-CART-018 (phone) | Order card DB-20261117-V73AZS not found in 10 pages | Same as 16-Nov (test limit) |
| TC-FLD-056 (desktop) | No logo upload exists | D-78 |
| SD-06 (desktop) | gk-shop sees "already waiting for approval", not the wizard tiles | E-27 |
| TC-LOC-008 (phone) | "Yes, delete" outside the viewport | D-148 (open product defect) |

### Failures on a first try that passed when run again

| Check | First try | Cause | Final |
|---|---|---|---|
| 36 rows: 21 checkouts with `HTTP 402: Insufficient wallet balance` (TC-CART-009/012, TC-ORD-001/006, TC-RBAC-023, TC-SEC-004/005, TC-PAY-010, TC-NTF-001 …), and 15 where the pay button stayed hidden or disabled for the same reason (TC-UX-002, TC-LOC-018/020/022/023/024 …); 109 more rows blocked "the customer wallet is too low" | 06.25–06.54 | Test funds ran out (E-33) | Pass in attempt 2 |
| SC-GW (gig worker journey) | 06.16, "the Ready partner inside the zone gets the offer: no offer within 90 s" | Timing; not traced (artifacts cleared by the next run) | Pass 07.02 |
| TC-DEL-001/010/012 (desktop, orders-delivery) | 07.25, order stayed READY after the rider's Accept | Not traced. The same case passed at 07.21 (order-lifecycle) and 07.55 (phone) | Pass 08.23 |
| TC-FUL-011 / TC-FLD-084 (desktop) | 07.29, substitute stayed PENDING 15 s after "Send to customer" | Not traced | Pass 08.27 |
| TC-FLD-126 (phone) | 07.49, PIN box of the location dialog not found | Not traced | Pass 08.33 |
| 29 phone rows (returns, support, purchase lists, cart, discovery, access-platform) | 07.59 and 08.15, `getaddrinfo ENOTFOUND` / `ERR_INTERNET_DISCONNECTED` | This Mac's network (E-31). The site watch from the same Mac failed in 3–4 ms with no connection at those moments, and the site answered 200 the minute before and after | Pass 08.33–08.39 |
| TC-DEL-001/010/012, TC-DEL-020, plus 32 rows blocked and 39 rows that depend on them (re-run 1) | 08.06–08.19, "no delivery offer reached the rider" | Test delivery e1c80a73 was left out for delivery on gk-rider by the 07.59 drop (E-32) | Pass 08.23–08.35 |

None of these shows a database symptom.
- Where it could be measured, dispatch offered the rider a job **0.15 s** after an order was packed (for example, DB-20261117-FB07FJ was packed at 08.37.43.595 and offered at 08.37.43.749).
- The three "not traced" first tries could not be inspected. Playwright clears its artifacts folder at the start of every run, so only the log text was kept.

### Blocked (102) and manual (26)

The same causes as 16-Nov:
- no rider2 / shopB session (23);
- shop B not taking orders or not delivering here;
- no verified society;
- missing loose, unpriced and shop C listings;
- the COD limit on gk-lc14;
- the host firewall (E-01, 3 guest rows);
- no SMS or WhatsApp provider;
- live Google Places;
- SD-01 to SD-05 and SD-07 (gk-shop's 29-Oct QA shop still waiting for approval).

New in the list: **8 rows** that expect the built-in test payment page now say "online payments on this site open /orders/pay/session/<id>" (E-30). TC-FUL-005/006 (desktop and phone) are blocked: "no delivery offer reached the rider within 20 s" (E-35).

## Payments (Cashfree sandbox only)

Staging's order gateway is **CASHFREE** (sandbox keys), as `/admin/payments/cashfree` showed at about 06.06, not the built-in test page (E-30). All payments below went through the **"Sandbox payment"** workflow with UPI **testsuccess@gocash**. No card, UPI ID or bank account details of a real person were used.

| # | What | Cashfree order | Workflow run | Paid | Confirmed in the app |
|---|---|---|---|---|---|
| **1** | **The S11 payment:** wallet top-up ₹10, customer gk-lc14 | `topup_1794875648418_01d449d2` (payment ed3917a3…) | [43988684954](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/43988684954), cf_payment_id 1476014685588358656 | 06.05.24 | **06.05.54 by the webhook**: TOP_UP COMPLETED, ₹429.50 → ₹439.50. `/api/wallet/verify` twice: `alreadyProcessed: true`, no second credit |
| 2 | Registration fee ₹1,178.82, shop BKS-000053 (next section) | intent f1783c3a… | [43989443565](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/43989443565), cf_payment_id 1476016079898602496 | 06.10.56 | **06.11.27**: fee PAID, shop live |
| 3 | Test funds ₹5,000, gk-lc14 | `topup_1794878847315_fb1082a2` | [43995726271](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/43995726271) | 06.58.18 | 06.58.44: ₹74.50 → ₹5,074.50 |
| 4 | Test funds ₹5,000, gk-lc14 | `topup_1794882875647_1d76f58e` | [44004008933](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/44004008933) | 08.05.26 | 08.05.53: ₹1,394.50 → ₹6,394.50 |

## Shop registration fee

The brief asked for the built-in test page (`/orders/pay/sandbox/…`, "Pay (success)"). That page is not reachable today:
- **The gateway changed.** Staging runs `PAYMENT_GATEWAY=CASHFREE`, so `POST /api/shops/{id}/registration-fee` opens a Cashfree checkout, `/orders/pay/session/<intent>` (E-30).
- **No test shop owes a fee.** Every shop of the seven test accounts has its fee settled.
- **gk-shop cannot register another shop.** Its 29-Oct QA shop is still waiting for approval, and the QA agent does not approve on staging.

So the fee was tested the way the onboarding tests on staging have done it since 08-Nov: a new wizard shop on the admin test account, paid through the Cashfree sandbox.

| Time | Step | Result |
|---|---|---|
| 06.08.49 | New wizard draft, referral E2ETEST1 | 200 in 149 ms (OPEN draft written) |
| 06.09.06 | GSTIN (checksum-valid test number; sandbox.co.in **test** service) | GSTIN VERIFIED in 4.8 s. The PAN went to MANUAL_REVIEW, as the test service answers PANs |
| 06.09.15–06.09.28 | Owner, address (Shop 14, Laxmi Road, Pune 411030), map pin, shop details (General trading, turnover ₹2 crore) | 200 each, about 130 ms |
| 06.09.34 | Create my shop and pay | **BKS-000053 "QA VPS Switch 8685"**, PENDING_APPROVAL, fee due **₹1,178.82** (₹999 + 18% GST) |
| 06.09.43 | `POST /api/shops/a04f66b9…/registration-fee` | 201: intent f1783c3a…, redirect `/orders/pay/session/f1783c3a…` |
| 06.10.56 | Paid in the Cashfree sandbox (payment 2 above) | UPI success |
| 06.11.18 | Fee page | Still "Payment pending" ([screenshot](staging-vps-switch-2026-11-17/fee-page-before-capture-0611-390.png)) |
| **06.11.27** | Capture | Fee **PAID ₹1,178.82**; shop **APPROVED** (live), as wizard shops go live when paid (owner's decision); membership to 17-Nov-2027; "registration fee paid" e-mail SENT 06.11.28 |
| 06.11.4x | Fee page | "QA VPS Switch 8685 is live … Shop ID BKS-000053" ([screenshot](staging-vps-switch-2026-11-17/fee-paid-shop-live-0611-390.png)) |

**Result: pass.** The fee was paid, captured, written and confirmed on the new database within 31 s of the payment. The shop went live through the wizard's automatic rule. The QA agent approved nothing.

## Cron

| Check | Result |
|---|---|
| Guest check TC-DSP-022: all 26 `/api/cron/*` entry points refuse a missing and a wrong token | **Pass** (06.07) |
| Calling each entry point with the secret | **Not run.** This session has no staging `CRON_SECRET`, and those suite checks are local-tier |
| Every-minute cron, notification retries | **Running.** 06.01.02–06.01.12: the last retry of 11 deliveries from 16-Nov. 06.12.46: retries of 06.11.27 deliveries. 06.20–08.41: 199 deliveries retried, 6 of them sent on a retry |
| Every-minute cron, shop-acceptance timeout | **Running.** DB-20261117-80HR6K (accept by 06.48.17) was cancelled and refunded at 06.49.01. DB-20261117-MCEXVE (accept by 06.55.36) at 06.56.02. Reason: "The shop did not accept the order in time" |
| Every-minute cron, 5-minute payments job | **Running.** 7 unpaid online test orders (placed 06.29) went to PAYMENT_FAILED together at 06.50.19 |
| Rider dispatch health (`/admin/exceptions`, 06.12) | No "Rider dispatch looks stalled" alert |
| Errors | None from the cron or the database. The only errors are the mail host's limit (E-34) |

**E-mail on staging (E-34, not the database).** The mail host refuses most messages during QA runs: `451 4.7.1 Ratelimit "hostinger_out_ratelimit"` and `450 4.7.1 too many messages`. In the 24 h to 08.41 there were 158 sent, 743 failed and 2,017 dead. The outbox retries and marks a delivery dead after 4 attempts, as designed. In-app notifications are not affected.

## Database health

- **No database symptom anywhere.** Every result row and run log was searched for a 5xx answer, "does not exist", too many connections, terminated connections, ECONNREFUSED, ETIMEDOUT and ECONNRESET. There were no hits from the site.
- **Site watch, 06.13–08.38 (145 samples):**
  - Uncached database search (`/api/shops?q=<unique>`): median **0.068 s**, p95 0.51 s, maximum 1.15 s.
  - Home page: median 0.127 s, maximum 1.06 s.
  - All answers were 200, except the two moments this Mac was offline (E-31).
  - The 8 searches over 0.5 s were all during the heavy signed runs.
- Writes seen working: draft and shop rows, payment intents and webhook captures, wallet top-ups, debits and refunds, orders through every state, returns and refunds, grievances, purchase lists, addresses, the notification outbox and the cron's sweeps.

## Test data changed on staging (test accounts and the E2E shop only)

- The 4 Cashfree sandbox payments above.
- A new live test shop, BKS-000053 "QA VPS Switch 8685", on gk-admin, referral E2ETEST1.
- E2E Four Features Bakery: online stock of Bread (5), Butter Cookies (30) and Buffalo Ghee (19) set to 100 at 08.04.
- Test delivery 47cb6720 (order e1c80a73) finished at 08.21.46 with the customer's code and a door photo.
- 9 READY test orders of the spoiled re-run cancelled by the customer at 08.22 (refunded).
- The suite's own test orders, returns, tickets and lists.

Not changed: no `/admin/settings` change, no approval, rejection or suspension, no hPanel, GitHub settings or database server change, no PR merged or labelled. Nothing was run on gokesari.com.

## What needs you

| Item | Why |
|---|---|
| **E-30**: keep `PAYMENT_GATEWAY=CASHFREE` on staging and update CLAUDE.md and `cashfree-sandbox-test-data.md`, or set SANDBOX again for fee tests | The docs and the brief still describe the built-in page; 8 suite rows are blocked by it |
| **E-34**: e-mail on staging | The mail host's cap is used up during QA runs, so most staging e-mails end DEAD |
| **E-33**: before each staging run, at least ₹3,000 in gk-lc14's wallet and stock on the bakery's preset listings | The suite does not top up or restock on staging |
| **E-35**: TC-FUL-005/006, no rider offer after the shop's "Packed — mark ready" click | To investigate; not the database |
| Unchanged from 16-Nov: D-148, D-149, the two old COD orders on gk-lc14, the 29-Oct QA shop waiting for approval, rider2 / shopB sessions | Same blocked and failed rows as before |
