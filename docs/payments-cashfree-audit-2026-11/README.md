# Cashfree payment integration — audit and fixes (7 Nov 2026)

Company: ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED.
Sites: **gokesari.com** (production, Cashfree PRODUCTION) and **test.gokesari.com**
(test, Cashfree SANDBOX). All times are IST (UTC+5:30).

**Status (8 Nov 2026, 05:26 IST):** released to gokesari.com. #360 (the audit fixes), #361 (F16, F17)
and #364 (staging queue) were merged into `main` at 05:13 IST through release PR #362, and the
post-deploy checks passed (TEST_RESULTS §8). gokesari.com still takes order payments with
`PAYMENT_GATEWAY=SANDBOX`; going live with Cashfree is the owner's list in OWNER_ACTIONS.md.

Read with: [TEST_RESULTS.md](TEST_RESULTS.md) (what was run, with ids and times),
[OWNER_ACTIONS.md](OWNER_ACTIONS.md) (what only the owner can do: Cashfree dashboard,
live ₹1 tests, app store builds), [docs/payments-gateway-2026-10.md](../payments-gateway-2026-10.md)
(the order-payment design) and [docs/testing/cashfree-sandbox-test-data.md](../testing/cashfree-sandbox-test-data.md).

The work was additive: existing flows keep their behaviour except where a flow was
broken (listed under "Fixes"). Cashfree's own guidance was loaded with
`npx @cashfreepayments/agent-skills add skills --frameworks claude-code` (installed
locally under `.claude/skills/`, git-ignored, not committed; its edit to CLAUDE.md
was not kept).

---

## 1. Code map (file → function → flow → environment)

Four separate Cashfree integrations, each switched on differently:

| Integration | On when | Base URL | Webhook |
|---|---|---|---|
| Direct PG calls (`fetch`, x-api-version 2023-08-01) | `CASHFREE_APP_ID` + `CASHFREE_SECRET_KEY` set (else MOCK) | `CASHFREE_ENV`: `sandbox.cashfree.com/pg` / `api.cashfree.com/pg` (`src/lib/env.ts` `cashfreeApiBase`) | `/api/webhooks/cashfree` |
| PG payment intents (orders, "Add my shop" fee, support services) | `PAYMENT_GATEWAY=CASHFREE` (default SANDBOX = in-app simulator) + rule `onlinePayments.enabled` for checkout | same | `/api/webhooks/payments/cashfree` |
| Secure ID — bank account verification (BAV v2 sync) | `CASHFREE_VERIFICATION_*` keys + rule `bankAccountCheck.enabled` (default off) | `CASHFREE_VERIFICATION_ENV` (else `CASHFREE_ENV`) | none (synchronous) |
| Payouts V2 | `CASHFREE_PAYOUT_CLIENT_ID/SECRET` + rule `payouts.provider=CASHFREE` (default BANK_FILE) | `CASHFREE_PAYOUT_ENV` | `/api/webhooks/payouts/cashfree` |

### Receive money

| Flow | File → function | Order id | Server-side confirmation | Env |
|---|---|---|---|---|
| Customer wallet top-up | `src/app/api/wallet/topup` → `services/payments.ts createTopUpOrder → createCashfreeOrder`; verify `api/wallet/verify` → `verifyAndCreditTopUp → cashfreeTopUpState`; webhook `api/webhooks/cashfree/route.ts → creditFromWebhook`; cron `reconcileCashfreeTopUps` (new) | `topup_<ms>_<hex>` | Get Payments for the order (never the browser) | both; MOCK without keys |
| Shop-owner prepaid wallet top-up | `api/shops/[id]/wallet/topup` → `createShopWalletTopUpOrder`; verify `api/shops/[id]/wallet/verify` → `verifyShopWalletTopUp`; UI `components/shop-wallet-topup.tsx` | `shoptopup_…` | same as above; credit `shop-wallet.ts creditShopWalletTopUp` | both; rule `shopWallet.enabled` |
| Shop self-registration fee (/shop/join) | `api/shop-registrations/[token]/pay` → `registration/service.ts startRegistrationPayment`; webhook → `processRegistrationPaymentEvent → approveRegistration` (auto-approval, owner account, receipt, wallet, commission); **new** `checkRegistrationPayment` (`api/shop-registrations/[token]/check-payment`) and cron `reconcileRegistrationPayments` | `reg_<ms>_<hex>` | signed webhook; now also Get Order + Payments | both; rule `selfRegistration.enabled` (default off). Fee = admin-set tier (`registration_fee_tiers`) |
| "Add my shop" / wizard registration fee | `api/shops/[id]/registration-fee` → `services/registration-fee-payment.ts` (payment intent, purpose SHOP_REGISTRATION_FEE) → capture handler → `shops.ts autoApproveShopIfReady` / `gov-auto-approval.ts` | `gk_<uuid>` | Get Order on webhook, return and cron | `PAYMENT_GATEWAY` (SANDBOX on both sites today) |
| Customer order checkout (ONLINE) | `api/checkout` → `payments/order-payments.ts startOnlineCheckout → intents.ts createPaymentIntent → gateway/cashfree.ts createOrder`; page `/orders/pay/session/<id>` (`gateway-session-launcher.tsx`); webhook `api/webhooks/payments/[gateway]` → `processing.ts handlePaymentWebhook → applyGatewayState`; cron `runPaymentReconciliation` | `gk_<uuid>` | always `fetchOrder` (Get Order + Payments), amount compared | rule `onlinePayments.enabled` (default off) + `PAYMENT_GATEWAY` |
| ₹1 bank-account check | `api/bank-account/verification` → `services/bank-accounts.ts startBankVerification` (`payment_methods: upi,dc,cc,nb`); confirm → `confirmBankVerification → settleAttempt → refundCashfree`; **new** cron `sweepBankVerifications` | `bankverify_…` | Get Payments | both; rule `bankAccounts` |
| Admin ₹1 / ₹2 payment test (**new**) | `/admin/payments/cashfree` → `payments/cashfree-health.ts startCashfreeLiveTest / finishCashfreeLiveTest` | `gktest_<stamp>_<hex>` | Get Order + Payments, then refund | both (FINANCE_MANAGE) |

### Send money

| Flow | File → function | Cashfree API | Env |
|---|---|---|---|
| Order refunds (cancel, part refund, after delivery) | `aftercare/refunds.ts computeRefundBreakdown / processOriginalRefund` → `payments/intents.ts refundPaymentIntent / submitRefund` → `gateway/cashfree.ts refund` | `POST /orders/{id}/refunds` (refund_id `gkrf_…`), status by `REFUND_STATUS_WEBHOOK` + `fetchRefund` + cron | `PAYMENT_GATEWAY` |
| ₹1 check refund | `bank-accounts.ts refundCashfree` (`bvr_…`); refresh on view; **new** sweep + safe retry | same | both |
| Shop settlements | `payouts/cycle.ts`, `payouts/batches.ts sendItem` → `payouts/providers/cashfree.ts createTransfer` | Payouts V2 `POST /payout/transfers`, x-api-version 2024-01-01, inline beneficiary | rule `payouts.provider` |
| Rider payouts | `rider-wallet/transfers.ts sendTransfer` | same | rule `riderPayouts.provider` |
| Dealer commission | `dealers/auto-payout.ts sendDealerPayout` | same | rule `dealerAutoPayout` |

Client side: `src/lib/cashfree-checkout.ts` loads `https://sdk.cashfree.com/js/v3/cashfree.js`
(`_modal` for top-ups, fee, ₹1, admin test; `_self` for orders) and — **new** — hands the
payment to Cashfree's mobile SDK inside the app (1.8.0+). Mobile: `mobile/` (Expo WebView
shell, `com.gokesari.app` / `com.gokesari.app.preview`); **new** `mobile/src/cashfree.ts`.

Refund amount on cancellation (`aftercare/refunds.ts computeRefundBreakdown`): CONFIRMED,
ACCEPTED and PREPARING ("before packing") refund the full `totalPaise`, **delivery fee
included**; a customer's own cancel after dispatch keeps `total − subtotal`; shop / operator
cancels refund in full.

---

## 2. Configuration checklist per environment

What the code enforces now, and what was observed. "Owner" = only visible in the Cashfree
dashboard or the Hostinger environment; the admin page `/admin/payments/cashfree` shows the
site's own view of each item.

| Check | test.gokesari.com (SANDBOX) | gokesari.com (PRODUCTION) |
|---|---|---|
| Base URL per env | `sandbox.cashfree.com/pg` — observed: top-up orders return `cashfreeMode: "sandbox"` (TEST_RESULTS §2) | `api.cashfree.com/pg` when `CASHFREE_ENV=production` (live keys confirmed set by the owner on 14 Oct, decision log D-R02) |
| No sandbox keys on prod / prod keys on test | **Now enforced** (`cashfreeEnvProblem`, `src/lib/env.ts`): test site refuses `production` env or `cfsk_ma_prod_` keys | **Now enforced**: refuses `sandbox` env or `TEST…` / `cfsk_ma_test_` keys — for payments, payouts and Secure ID |
| Keys only from env / secret store | Yes: `getEnv()` only. Mobile app holds no key (session id only) | Yes |
| Keys committed to git history | **None.** Full history scanned (1,150 commits, all branches, unshallowed): only test placeholders (`test-webhook-secret`, `cf-verify-secret`) | — |
| return_url / notify_url domain | Built from `PAYMENT_PUBLIC_BASE_URL` / `AUTH_URL` (never from the request). Top-up orders had **no** notify_url → **fixed** (https only). Admin page flags a base URL that is not https or not this site | same |
| Webhook registered in dashboard | Owner (OWNER_ACTIONS §1). Both URLs listed on `/admin/payments/cashfree` | Owner |
| Signature verified | `/api/webhooks/cashfree`: HMAC-SHA256(timestamp + raw body), base64, constant-time; `/api/webhooks/payments/cashfree`: same + 5-minute freshness + event-id dedupe; payouts: same, dedupe by transfer id | same |
| Domain whitelisting (gokesari.com) and app package ids | n/a in sandbox | Owner: Developers → Whitelisting — `gokesari.com`, `www.gokesari.com`; app `com.gokesari.app` (Android + iOS) for the mobile SDK |
| Status confirmed server-side | Yes for every flow (Get Order / Payments, or the signed webhook for the fee); the registration fee now also re-checks with Get Order | same |
| Amount / currency set server-side | Yes: top-up amount bounded by rule `walletTopup`, fee from the registration row, orders from server pricing, ₹1 from rule. **New**: top-up credit refused when Cashfree reports less money or another currency | same |
| API version | PG `2023-08-01` (still accepted; latest is `2026-01-01`, previous `2025-01-01`) — upgrade is a separate, planned change (see §6) | same |

---

## 3. Payment modes — receive money

Cashfree's "Get Eligible Payment Methods" is the only source of truth for what is switched
on for the merchant account. This environment cannot reach Cashfree and holds no keys, so it
is asked **by the site itself** from `/admin/payments/cashfree` → "Ask Cashfree" (shipped in
this change); the staging result is in TEST_RESULTS, production is OWNER_ACTIONS §2.

| Mode | Top-up (customer) | Shop wallet top-up | Registration fee | ₹1 bank check | Order checkout (Cashfree) | Web | Android app | iOS app |
|---|---|---|---|---|---|---|---|---|
| Credit card | all methods shown (no filter) | all | all | yes (`cc`) — proves a card, not a bank account | `CARD` → `cc,dc` | Cashfree JS v3 | **1.8.0: Cashfree SDK** (before: web checkout in WebView) | **1.8.0: Cashfree SDK** |
| Debit card | yes | yes | yes | yes (`dc`) | `CARD` | yes | SDK | SDK |
| UPI collect | yes | yes | yes | yes | `UPI` | yes | SDK | SDK |
| UPI intent / QR / UPI apps | QR on desktop, intent on phone browsers | same | same | same | same | yes | **SDK opens the UPI app** (+ `<queries>` for `upi:`); before 1.8.0 the `intent://` package was dropped | **SDK + LSApplicationQueriesSchemes** (phonepe, tez, gpay, paytmmp, bhim, credpay, amazonpay …) |
| Wallets (Paytm, PhonePe, Amazon Pay …) | yes, if enabled on the account | yes | yes | no (by design: a wallet does not prove a bank account) | **new `WALLET` → Cashfree `app`** (added to rule `onlinePayments.methods`, default now includes it) | yes | SDK | SDK |
| Net banking | yes | yes | yes | yes (`nb`) | `NETBANKING` → `nb` | yes | SDK | SDK |

The shop-owner prepaid wallet top-up sends no method filter, so it offers every mode the
account has switched on (card, UPI, wallets, net banking).

**Order checkout through Cashfree (7 Nov 2026, TEST_RESULTS §7):** credit card, debit card, UPI collect, the
PhonePe wallet and net banking each paid an order, confirmed by Cashfree's webhook. Also tested: failure then "Retry payment",
pending, customer cancel, a full refund including the delivery fee, and a partial (line) refund. This was after F17;
before it, every Cashfree order checkout failed.

**Observed on the test site's Cashfree sandbox account (7 Nov 2026, TEST_RESULTS §2):** credit
card, debit card, UPI collect (success and failure), net banking (3003) and the **PhonePe** and
**Amazon Pay** wallets all took payments; the **Paytm** wallet answered "mode not enabled for
merchant" (`payment_method_unsupported`) — ask Cashfree to enable it if Paytm should be offered.
The production account's list comes from "Ask Cashfree" on gokesari.com (OWNER_ACTIONS §2).

---

## 4. Send money — refunds, payouts, ₹1 verification

| Item | Finding |
|---|---|
| PG refunds | Back to the original card / UPI / wallet via `POST /orders/{id}/refunds`; idempotent `refund_id`; final state from `REFUND_STATUS_WEBHOOK` + Get Refund + the 5-minute cron. Speed: **STANDARD** (Cashfree default; `refund_speed` was never sent). **New** optional `CASHFREE_REFUND_SPEED=INSTANT` (only once Cashfree enables instant refunds). Partial refunds are supported (`PARTIALLY_REFUNDED` state; cap = amount captured). |
| Full refund incl. delivery fee before packing | Yes — CONFIRMED / ACCEPTED / PREPARING cancellations refund `totalPaise` with no deduction (`aftercare/refunds.ts`). |
| Payouts | Cashfree Payouts V2 adapter exists (bank account + UPI, IMPS/NEFT/RTGS/UPI rails, inline beneficiary — no beneficiary-add call), **not in use** (rule defaults BANK_FILE / SANDBOX). 2FA: production needs the server IP whitelisted (no `X-Cf-Signature` support). Webhook V2 signature verified. **Card payouts are not supported** by our code (Cashfree supports them only to tokenised credit cards; not needed for shops / riders). Two bugs fixed (§5). |
| ₹1 bank verification | **Not Secure ID penny drop / reverse penny drop.** It is a ₹1 Cashfree PG payment by UPI, debit card, credit card or net banking, matched to the declared account (payer name ≥ threshold, else payer account last-4 + IFSC, else payer UPI id), then **refunded**. Secure ID BAV (a true penny-less bank check) runs first when its keys and rule are on. A credit-card (and often a sandbox) ₹1 ends as `PAYMENT_ONLY`, which counts as verified — that proves a payment card, not the bank account: **owner decision** (OWNER_ACTIONS §5). |

---

## 5. Fixes made (all additive, all with tests)

| # | Gap | Fix | Where | Test |
|---|---|---|---|---|
| F1 | A top-up still PENDING at the bank (UPI) was marked FAILED when the customer's check came back first; the later success webhook was ignored → **customer paid, wallet not credited** | Pending / not-attempted stays open; FAILED only when every attempt failed | `services/payments.ts verifyAndCreditTopUp, cashfreeTopUpState` | `tests/integration/cashfree-audit-2026-11.test.ts` |
| F2 | A FAILED top-up that Cashfree later reports paid could never be credited | Webhook and the customer's own check re-confirm with Cashfree's API, reopen and credit once (audit `wallet.topup_late_success`) | `creditFromWebhook, recoverLateTopUp` | same |
| F3 | No safety net for top-ups whose webhook never arrived | Cron `payments-reconcile` checks open Cashfree top-ups (10 min – 3 days) | `reconcileCashfreeTopUps`, `cron/schedule.ts` | same |
| F4 | Top-up orders had no `notify_url` (webhook depended on dashboard set-up) and no expiry | `order_meta.notify_url` (https only) + 60-minute `order_expiry_time` | `createCashfreeOrder`, `payments/cashfree-env.ts` | same |
| F5 | Paid amount / currency not compared before crediting a top-up | Less money or non-INR → nothing credited, audit `wallet.topup_amount_mismatch` | `amountMismatch` | same |
| F6 | Registration fee approved **only** by the webhook — a lost webhook left a paid shop waiting | Get Order + Payments → the same `processRegistrationPaymentEvent` (same fee checks, one-time approval): on the applicant's page after checkout and in the cron | `registration/service.ts reconcileRegistrationPayment, checkRegistrationPayment, reconcileRegistrationPayments`; `join-status.tsx` | same |
| F7 | Nothing stopped sandbox keys on gokesari.com (pretend money buying real goods) or production keys on the test site | Guard for payments, payouts and Secure ID | `lib/env.ts cashfreeEnvProblem`; gateway `isConfigured`, payout `isConfigured`, `callCashfreeBav`, every order creation | `tests/unit/cashfree-audit-2026-11.test.ts` |
| F8 | Wallets could not be offered at order checkout | `WALLET` method → Cashfree `app`; Cashfree `wallet` payment group mapped | `gateway/types.ts, cashfree.ts, common.ts`, rule `onlinePayments` | unit |
| F9 | Payouts: `transfer_id` cut to 40 chars → **every shop in a cycle got the same id** (and rider / dealer retries reused theirs) | Short keys unchanged; long keys → `gk` + 38 hex of SHA-256 (unique, deterministic) | `payouts/providers/cashfree.ts cashfreeTransferId` | unit |
| F10 | Payouts: a timeout / 5xx was marked FAILED and retried with a new transfer → **double pay risk** | Outcome unknown → stays PROCESSING (event `TRANSFER_OUTCOME_UNKNOWN`), webhook or finance settles it | `payouts/batches.ts sendItem` | existing payout suite |
| F11 | ₹1 checks paid but never confirmed (app closed) kept the ₹1; failed refunds were never retried | Cron settles them from Cashfree's record (same matching, refund); pending / failed refunds are re-checked and resent only when Cashfree has none | `bank-accounts.ts sweepBankVerifications, retryCashfreeRefund` | `tests/integration/bank-accounts.test.ts` |
| F12 | No way to see a site's Cashfree set-up, the eligible methods, or run a controlled live test | `/admin/payments/cashfree`: set-up + problems, "Ask Cashfree" (keys + eligible methods), ₹1 test and ₹2 partial-refund test with immediate refund, history in IST | `payments/cashfree-health.ts`, `components/cashfree-admin-panel.tsx`, `api/admin/payments/cashfree/*` | integration |
| F13 | Mobile apps used Cashfree's web checkout in a WebView: the UPI app chosen in `intent://` was dropped, bank pages in a new window went to the browser | App 1.8.0: Cashfree React Native SDK (`react-native-cashfree-pg-sdk` 3.0.0) — web checkout and UPI-intent checkout; Android `<queries>` for `upi:`; iOS UPI schemes; the build refuses the wrong environment; the website still confirms every payment with its server | `mobile/src/cashfree.ts, cashfree-request.ts, App.tsx, bridge-script.ts, app.config.ts`; `src/lib/cashfree-checkout.ts` | `mobile/src/__tests__/cashfree.test.ts` |
| F16 | Found on staging after #360: Cashfree sends `cf_payment_id` in card / net-banking webhooks as a JSON number above 2^53; `JSON.parse` rounded it (`1472617385555189760` stored as `…189800`). No double credit, but the stored reference was not Cashfree's | Exact digits read from the raw webhook body (kept only when equal to the parsed number) — top-up / registration-fee webhook and the order-gateway adapter | `gateway/common.ts exactJsonId`, `api/webhooks/cashfree/route.ts`, `gateway/cashfree.ts` | unit + integration (the staging ids) |
| F17 | Found on staging when `PAYMENT_GATEWAY=CASHFREE` was set (7 Nov, 21:52 IST): **every Cashfree order checkout failed** ("We could not start the payment just now"). The order adapter sent `order_expiry_time` = the intent expiry (`onlinePayments.intentExpiryMinutes`, 15 by default, counted from before the call), which reached Cashfree just under its 15-minute minimum, so Cashfree refused the order. with the default rule, gokesari.com would have hit this as soon as it switched to Cashfree | The Cashfree order gets at least 16 minutes (the floor the top-up and live-test orders already use); a longer expiry is sent unchanged; the intent stores the expiry Cashfree returns. The sandbox and other gateways are untouched | `gateway/cashfree.ts cashfreeOrderExpiryTime` | unit (`tests/unit/cashfree-audit-2026-11.test.ts`); staging O0 → O1–O10 (TEST_RESULTS §7); confirmed at the default 15 minutes after release to staging (§8, F17-3/F17-4) |
| F15 | Site CSP narrower than Cashfree's documented one: `form-action 'self'` can block the `_self` hosted checkout (order payments) if Cashfree opens it by form post; no `sdk.cashfree.com` in `img-src` / `style-src` | Added `https://*.cashfree.com` to `form-action` and `https://sdk.cashfree.com` to `img-src` / `style-src` (Cashfree's web-SDK guidance); nothing else widened | `next.config.ts` | browser checkout on staging (TEST_RESULTS §3 A12) |
| F14 | Sandbox test tool could not test wallets, pending, user-cancel or UPI intent | New instruments `wallet-*`, `*-pending`, `*-dropped`, `upi-intent`, `upi-qr` | `scripts/test-site/sandbox-pay.mjs`, `.github/workflows/sandbox-pay.yml` | staging runs |

---

## 6. Security review (Cashfree security-review skill, payment flow only)

### Findings (fixed or reported)

1. **[Critical → fixed F7] Sandbox Cashfree on the production site is not refused** — `src/lib/env.ts:333` (before). Exploit: production running `CASHFREE_ENV=sandbox` + TEST keys lets anyone pay with test card 4111… and receive real wallet credit to buy real goods. Fix: environment guard on every Cashfree entry point.
2. **[High → fixed F1/F2] Paid top-up never credited** — `services/payments.ts:292` (before). A UPI payment pending when the browser checks is marked FAILED; the success webhook then returns early.
3. **[High → fixed F9] Payout transfer_id collision** — `payouts/providers/cashfree.ts:61` (before): `slice(0, 40)` of `payout-item:<cycle>:<shop>:<n>`.
4. **[High → fixed F10] Unknown payout outcome retried as a new transfer** — `payouts/batches.ts:222` (before).
5. **[Medium → fixed F5] Top-up credit did not compare Cashfree's paid amount / currency** — `services/payments.ts:681` (before). Not exploitable today (amount fixed at order creation), defence in depth.
6. **[Medium → fixed F6] Registration approval depended on the webhook alone.**
7. **[Medium, reported] `/api/webhooks/cashfree` has no timestamp window** (`route.ts:52`). A replay is a no-op (status checks, UNIQUE `gateway_payment_id`, one-time approval), so no window was added — a 5-minute window could also reject Cashfree's own retries at 10 and 30 minutes if they keep the first timestamp. The order webhook keeps its window and has the 5-minute reconcile cron behind it.
8. **[Medium, reported] Order checkout: a failed first attempt ends the intent** (`gateway/cashfree.ts:100`) — a retry inside the same Cashfree session then becomes `LATE_CAPTURE` (support alerted, no auto-refund). Owner decision D-A09; unchanged.
9. **[Medium, reported] `PAYMENT_ONLY` counts as a verified bank account** (`bank-accounts.ts:528`) — see §4; owner decision.
10. **[Low, reported] Refund sweep heuristic** (`aftercare/refunds.ts:894`) can mark one refund done from another refund on the same ORDER_GROUP intent; and a gateway-FAILED refund leaves the order REFUND_PENDING without the wallet fallback (`intents.ts:468`). Only with `PAYMENT_GATEWAY=CASHFREE` and multi-shop / part refunds; recommended follow-up.
11. **[Low, reported] Operator payment links expire after `intentExpiryMinutes` (15) not the promised 72 h** (`operator-limited.ts:329`); **a failed support-service payment cannot be retried** (`support-services.ts:358`).

No finding for: client-trusted status (every flow re-asks Cashfree), return_url as proof
(never used), secrets in frontend / app (session id only), raw-body signature (all three
webhooks use `request.text()`), constant-time compare (all use `timingSafeEqual`), PCI (no
card data stored or logged; the sandbox tool does not echo card numbers), SSRF via
notify/return URL (built from env only), error leaks (generic messages; Cashfree bodies only
in server logs).

### Dependency posture

- Cashfree PG: no SDK on the server (direct REST), x-api-version **2023-08-01** — supported
  but two versions behind (`2025-01-01`, `2026-01-01`). Plan the upgrade separately with the
  upgrade-advisor (changes response shapes; not done here to keep this change additive).
- Checkout: Cashfree JS v3 (hosted by Cashfree, always current).
- Mobile: `react-native-cashfree-pg-sdk` 3.0.0 (Android `com.cashfree.pg:api` 2.6.0, iOS `CashfreePG` 2.5.2), `cashfree-pg-api-contract` 2.2.0.
- Scanner: `npm audit` (see TEST_RESULTS §6 for the run and its triage).

### Secrets to rotate

**None found committed.** No Cashfree App ID / secret, payout secret, Secure ID secret or
webhook secret appears anywhere in the git history (all 1,150 commits on every branch).

---

## 7. Cashfree go-live checklist (gokesari.com) — status on 7 Nov 2026

The integration code looks correct for production, but these items must be done (or confirmed)
before it can be called live-ready:

| Item | Status |
|---|---|
| KYC completed, production keys generated | Done per owner (14 Oct, D-R02) — re-confirm on `/admin/payments/cashfree` ("keys accepted") |
| Domain whitelisted (gokesari.com, www) / app whitelisted (com.gokesari.app) | **Owner** (OWNER_ACTIONS §3) |
| Webhooks configured in production (both URLs, HTTPS) | **Owner** (OWNER_ACTIONS §1) — orders now also send their own notify_url |
| Payment methods enabled (card, UPI, net banking, wallets) | **Owner** — "Ask Cashfree" on gokesari.com (OWNER_ACTIONS §2) |
| API alerts configured in the dashboard | **Owner** |
| Base URL `api.cashfree.com/pg`, production keys, SDK environment PRODUCTION | Enforced by the new guard (site refuses otherwise); app builds pick the environment from the site |
| No test data / sandbox URLs in return_url / notify_url | Done — built from `PAYMENT_PUBLIC_BASE_URL` / `AUTH_URL`; sandbox test data only in docs and the test-site tool |
| Signature verification with the production secret | Done (`CASHFREE_SECRET_KEY` of the environment) |
| Security review: no unresolved Critical / High in the payment flow | Done — all Critical / High fixed (§6); Medium / Low reported |
| Small real payment (₹1), seen in the dashboard, webhook received, PAID read, refund processed | **Owner** — admin ₹1 test (OWNER_ACTIONS §4) |
| Mobile app tested via Play Store internal testing / TestFlight | **Owner** (OWNER_ACTIONS §6) |
