# Cashfree — testing report (7 Nov 2026, all times IST)

Per environment, per mode, per flow. Order ids, `cf_payment_id`s and refund ids are
Cashfree's own. Sandbox payments were made with Cashfree's **sandbox test data only**
([docs/testing/cashfree-sandbox-test-data.md](../testing/cashfree-sandbox-test-data.md)) through
the "Sandbox payment" GitHub workflow (`.github/workflows/sandbox-pay.yml`), because this build
environment cannot reach Cashfree. Staging accounts: the QA test accounts (customer `gk-lc14`,
shop owner `gk-shop`, admin `gk-admin`), signed in with the emailed code.

Status legend: **PASS**, **FAIL** (a defect, with its fix), **OWNER** (needs the owner — see
[OWNER_ACTIONS.md](OWNER_ACTIONS.md)), **AFTER DEPLOY** (re-run once this change is on
test.gokesari.com through the staging queue).

---

## 1. Automated tests (this change)

| Suite | Result | When |
|---|---|---|
| `tests/integration/cashfree-audit-2026-11.test.ts` — pending top-up stays open; late success via webhook / own check, once; not credited when Cashfree does not confirm; never to another user; amount / currency mismatch; convenience fee; reconcile job (paid / pending / unpaid / too new / no keys); notify_url + expiry; registration fee by reconcile job and by "check payment" (+ mismatch, + pending); admin health with eligible methods; ₹1 test with refund once; ₹2 partial then full refund | **18 / 18 PASS** | 7 Nov, 19:20–19:45 |
| `tests/unit/cashfree-audit-2026-11.test.ts` — site kind, key kind, env guard for payments / payouts / Secure ID, gateway + payout `isConfigured` on a mismatched site, payout `transfer_id` uniqueness, WALLET → `app`, order expiry | **9 / 9 PASS** | 7 Nov, 19:25 |
| `tests/integration/bank-accounts.test.ts` (+2 new: stranded ₹1 settled and refunded; failed refund resent only when Cashfree has none) | **all PASS** (31 with payouts suite) | 7 Nov, 19:30 |
| Existing payment suites: `cashfree-order-confirmation`, `payments`, `wallet-route`, `bank-account-check`, `shop-self-registration`, `qa-2026-10-24-money-fixes`, `batch-a-gateways`, `webhook-signature`, `batch-e-units`, `batch-e-payouts` | **all PASS** (125 + 31) | 7 Nov, 19:23–19:30 |
| Mobile `npm test` (incl. new `cashfree.test.ts`: build ↔ environment check, request validation, cancel vs failure, bridge API, UPI schemes) | **59 / 59 PASS** | 7 Nov, 19:20 |
| Typecheck + lint (web and mobile); Expo config introspection (Android `<queries>` has `upi`, iOS `LSApplicationQueriesSchemes`, version 1.8.0 / build 9) | **PASS** | 7 Nov |
| Full web suite, locally against PostgreSQL 16 (all 272 files) | **3,380 / 3,380 PASS** (75 min) | 7 Nov, 19:30–20:45 |
| Android APK builds with the Cashfree SDK compiled in (gradle, preview + production) | **PASS** on the PR (19:50–19:57) | 7 Nov |

Webhook **retry** and **duplicate** are covered here, not on staging (Cashfree cannot be made to
resend on demand): a repeated signed webhook changes nothing (`… is credited once by the signed
webhook …`, `shop-self-registration` "duplicate (and concurrent) webhook approves exactly once",
`payments` webhook dedupe by event id); a retry after a processing error is processed (500 →
Cashfree retries; `payment_webhook_events.processed_at` empty until done).

---

## 2. test.gokesari.com (Cashfree SANDBOX) — before this change (deployed code)

Customer wallet top-up, then shop wallet top-up. "Webhook credit" = was the wallet credited by a
webhook alone, before anyone called verify (about two minutes after paying).

| # | Paid (IST) | Mode / test data | Order | Amount | cf_payment_id | Run | Webhook credit | Server-side verify | Result |
|---|---|---|---|---|---|---|---|---|---|
| B1 | 19:35:15 | Credit card, Visa 4111 1111 1111 1111, OTP 111000 | topup_1794060255250_15bc886c | ₹10 | 1472594572554252800 | [#29](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379856526) | no | 19:37:04 credited, ₹7,195 → ₹7,205 | PASS (verify) / **FAIL (webhook)** |
| B2 | 19:35:38 | Debit card 4706 1312 1121 2123 | topup_1794060271337_c453358c | ₹10 | 1472594657614737920 | [#30](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379880702) | no | 19:37:07 credited → ₹7,215 | PASS / **FAIL (webhook)** |
| B3 | 19:35:32 | UPI collect testsuccess@gocash | topup_1794060272842_7ab231f6 | ₹11 | 1472594684219208192 | [#31](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379884028) | no | 19:37:10 credited → ₹7,226 | PASS / **FAIL (webhook)** |
| B4 | 19:35:23 | UPI collect testfailure@gocash (failure) | topup_1794060274127_a6c09da6 | ₹12 | 1472594646831182336 | [#32](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379887424) | — | 19:37:13 refused, nothing credited | PASS |
| B5 | 19:35:35 | Net banking, bank 3003 | topup_1794060275409_6bc2cb20 | ₹13 | 1472594657363079680 | [#33](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379890865) | no | 19:37:46 credited → ₹7,239 | PASS / **FAIL (webhook)** |
| B6 | 19:35:56 | Card attempt not finished (simulator left open) | topup_1794060276671_ef39ef71 | ₹14 | 1472594700379861504 | [#34](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42379894446) | — | 19:37:15 refused **and marked FAILED** | **FAIL → F1** |
| B7 | 19:39:32 | **Shop wallet** top-up, UPI collect testsuccess@gocash (shop "E2E Four Features Bakery") | shoptopup_1794060518837_bbd7650e | ₹100 | (run #35) | [#35](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42380202577) | no | 19:39:44 (12 s after paying, UPI still settling) refused and marked FAILED; 19:39:59 409 "can no longer be completed"; shop wallet stays ₹854.90 | **FAIL → F1, F2** (paid, never credited) |

| B8 | 19:43:54 | **Wallet — PhonePe** (Order Pay `app`, new tool instrument) | topup_1794060773833_01c27f5b | ₹15 | 1472596749674852864 | [#37](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42380551937) | — | 19:44:15 credited → ₹7,254 | PASS |
| B9 | 19:43:38 | **Wallet — Paytm** | topup_1794060775171_2126ce42 | ₹16 | — | [#38](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42380556240) | — | Cashfree: "mode not enabled for merchant: paymentCode 11194433:4007" (`payment_method_unsupported`) | Paytm wallet **not enabled** on the sandbox account (OWNER) |
| B10 | 19:45:18 | **Wallet — Amazon Pay** (same order as B9; left **unverified on purpose**) | topup_1794060775171_2126ce42 | ₹16 | 1472597101681816064 | [#39](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42380661902) | no | not called — for the reconcile job after deploy (§3 A2) | PASS (payment) |
| B11 | 19:45:50 | **₹1 bank check**, debit card 4706 1312 1121 2123 (customer bank account, was PENDING) | bankverify_1794060899160_aca1485f | ₹1 | 1472597236595798528 | [#40](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/42380709607) | — | 19:46:08 account **VERIFIED** (match `PAYMENT_ONLY` — the sandbox gives no payer name), ₹1 **refund SUCCESS** (refund id `bvr_…`, Cashfree sandbox) | PASS (full refund) |

Findings from this run:

- **No webhook reached the site for any top-up** (B1–B3, B5, B7). Top-up orders carried no
  `notify_url`, so crediting depended on the browser calling verify — a customer who paid and
  closed the page was never credited. Fixed by F4 (notify_url), F3 (reconcile job); dashboard
  webhook: OWNER_ACTIONS §1.
- **A UPI payment checked a few seconds early is lost** (B7): reproduced live. Fixed by F1 (pending
  stays open) and F2 (a FAILED one that Cashfree later reports paid is credited). B7 is the
  re-test after deploy (§3, A1).
- The sandbox tool could not pick the simulator's new "Select failure type" dropdown (B6) — fixed
  in `scripts/test-site/sandbox-pay.mjs` (F14).
- Hostinger's bot screen answered 403 to a burst of API calls (B5 first try); a retry 20 s later
  passed. Not a payment defect.

---

## 3. test.gokesari.com (SANDBOX) — after this change  ·  AFTER DEPLOY

To run once the PR is `staging-verified` (sandbox-pay workflow dispatched on the PR branch for
the new instruments):

| # | Flow / mode | Expected |
|---|---|---|
| A1 | Re-verify B7 (`shoptopup_1794060518837_bbd7650e`) | credited once (late success), shop wallet +₹100 |
| A2 | Top-up paid, verify **not** called | credited by webhook (`notify_url`) or by `payments-reconcile` within 5–15 min |
| A3 | Card PENDING (simulator) then verify | 400 "bank has not confirmed yet", payment stays open |
| A4 | Card USER_DROPPED (customer cancels) | nothing credited; FAILED |
| A5 | Card FAILED (failure type chosen) | nothing credited |
| A6 | Wallet success (PhonePe / Paytm, sandbox) | credited |
| A7 | UPI intent / QR (shape only) | Cashfree returns a `upi://` payload / QR |
| A8 | `/admin/payments/cashfree` → Ask Cashfree | keys accepted, eligible methods listed |
| A9 | ₹1 test (card) and ₹2 partial-refund test | refund ids, partial then full |
| A10 | Shop wallet top-up by UPI, card, wallet, net banking | credited each |
| A11 | Guard: none expected on staging (sandbox env) | "No set-up problems" |
| A12 | Browser checkout (cashfree.js modal for a top-up, `_self` for an order) on a desktop and a phone browser | no CSP errors in the console; the checkout opens and returns (needs a person with a browser: **OWNER**) |

---

## 4. gokesari.com (PRODUCTION)

| Check | How | Result |
|---|---|---|
| Webhook secret configured (`CASHFREE_SECRET_KEY` set) | 19:47:53 `POST https://gokesari.com/api/webhooks/cashfree` with no signature → **400 "Missing signature"** (not 503 "not configured"); nothing written. Same on test.gokesari.com 19:47:55 | **PASS** |
| HTTPS + CSP allows Cashfree | `script-src https://sdk.cashfree.com`, `connect-src https://*.cashfree.com`, `frame-src https://*.cashfree.com` on both sites; `form-action 'self'` / no `sdk.cashfree.com` in img/style — widened for Cashfree by F15 | PASS / fixed |
| Live keys set, `CASHFREE_ENV=production` | owner confirmation 14 Oct (decision log D-R02) | as recorded; to re-confirm on `/admin/payments/cashfree` after release (**OWNER**) |
| No sandbox keys / env on production | the new guard refuses them; the admin page lists the problem | **AFTER DEPLOY** to production |
| Webhook URLs, domain + app whitelisting, eligible methods | Cashfree dashboard / admin page | **OWNER** (OWNER_ACTIONS §1–3) |
| One live ₹1 per mode (credit card, debit card, UPI, wallet), refunded at once | admin page ₹1 test | **OWNER** (OWNER_ACTIONS §4) — needs the owner's own card / UPI / wallet; not run from here |
| Live payout | not in use (`payouts.provider` BANK_FILE) | not run |

No production money was moved by this work.

---

## 5. Mobile apps

| Item | Result |
|---|---|
| Unit tests, typecheck, lint, config introspection | PASS (§1) |
| Android APK build with the Cashfree SDK (gradle) | in the "Mobile APK" workflow on the PR |
| Sandbox payment in the **test app** (preview build) on a phone: card, UPI app, wallet | **OWNER** (needs a device) — install the PR's `GoKesari-preview` APK |
| iOS build (EAS) and TestFlight | **OWNER** (Actions → "Mobile iOS") |

---

## 6. Dependency scan (npm audit, production dependencies)

- Website: **0** advisories.
- Mobile: 13 advisories (3 high, 9 moderate, 1 low), all in Expo's build tooling (`@expo/cli`,
  `@expo/config*`, `glob`, `minimatch`, `node-forge`, `uuid`, `zod` via `@expo/cli`) — none in the
  Cashfree SDK or any package on the payment path; not actioned here (Expo SDK upgrade).
