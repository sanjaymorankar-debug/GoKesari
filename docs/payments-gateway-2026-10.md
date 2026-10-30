# Direct online payment — payment gateway (batch 2026-10, WS-A)

Features: **F1.7.3** direct online payment of orders and **F1.8.4** payment
state machine (GS-028, NEW-007, SM-005, GS-073). Status: built, **OFF by
default** (rule `onlinePayments.enabled = false`).

> **Production stays OFF** until (1) the gateway is chosen, (2) the merchant
> account is open, (3) the live keys and (4) the webhook secret are set on
> gokesari.com. Until then customers pay from the wallet or cash on delivery,
> exactly as before.

## 1. Architecture

```
 customer ── checkout (paymentMethod ONLINE) ──► POST /api/checkout
                                                  └─ startOnlineCheckout()          server/payments/order-payments.ts
                                                       ├─ checkout()  (same pricing, stock, slots, coupons; order PENDING)
                                                       └─ createPaymentIntent()       server/payments/intents.ts
                                                            └─ getPaymentGateway()    server/payments/gateway/registry.ts
                                                                 ├─ SandboxGateway    (default; tests + staging)
                                                                 ├─ CashfreeGateway   (PG API 2023-08-01)
                                                                 ├─ RazorpayGateway   (scaffold)
                                                                 └─ PhonePeGateway    (scaffold)
 browser ──► gateway's hosted page (sandbox: /orders/pay/sandbox/<ref>; Cashfree: /orders/pay/session/<intent> opens its JS checkout)
 gateway ──► POST /api/webhooks/payments/<gateway>    → handlePaymentWebhook()   server/payments/processing.ts
                1. verify signature over the raw body (bad → 401, recorded)
                2. INSERT payment_webhook_events ON CONFLICT (gateway, event_id) DO NOTHING → repeat = ignored
                3. reconcile: gateway.fetchOrder() / fetchRefund() — the gateway's own record decides
                4. one transaction, SELECT … FOR UPDATE on the intent, state machine checked,
                   CAPTURED_HANDLERS[purpose] / PAYMENT_ENDED_HANDLERS[purpose] in the same transaction
 browser ◄── /orders/payment-return?intent=<id>   polls GET /api/payments/intents/<id> (which also re-asks the gateway)
 cron    ──► POST /api/cron/payments-reconcile    stuck intents, queued / pending refunds, orphan orders
```

Card, UPI and bank details are only ever typed into the gateway's own page —
never into GoKesari. Money is integer paise everywhere; adapters convert to
rupees only at the gateway boundary (Cashfree).

### Tables (customer database, migration `drizzle/0079_batch_a_payments.sql`)

| Table | What |
|---|---|
| `payment_intents` | one gateway payment for one purpose (`ORDER`, `ORDER_GROUP`, `SHOP_REGISTRATION_FEE`): amount, refunded, status, gateway ids, `idempotency_key` UNIQUE, checkout URL / SDK token / link URL, expiry |
| `payment_intent_events` | every status move with its source (API, WEBHOOK, RECONCILE, REFUND) |
| `payment_webhook_events` | every delivery; `(gateway, event_id)` UNIQUE is the processing idempotency key; signature result, outcome, raw payload |
| `payment_refunds` | refunds to the original method: `merchant_refund_id` UNIQUE (gateway idempotency), amount, PENDING / SUCCESS / FAILED |
| `payment_sandbox_orders` | the sandbox gateway's own ledger (tests and staging only) |

`payment_method` gains the value `ONLINE`.

## 2. State machine (`payment_intent`, `src/lib/payment-intent-states.ts`)

```
CREATED ──► PENDING ──► AUTHORIZED ──► CAPTURED ──► PARTIALLY_REFUNDED ──► REFUNDED
   │           │             │             └──────────────────────────────►┘
   │           │             │                (a full refund in one go)
   └───────────┴─────────────┴──► FAILED   (terminal)
                                  EXPIRED  (terminal)
```

* Forward skips are legal (a gateway may report CAPTURED straight away);
  nothing moves backwards; FAILED / EXPIRED / REFUNDED are final.
  `PARTIALLY_REFUNDED → PARTIALLY_REFUNDED` is a second partial refund.
* Every move goes through `transitionIntent()` (intent-store.ts): checked
  with `canMove("payment_intent", …)`, written to `payment_intent_events`,
  audited, and emitted (`payment.pending / authorized / captured / failed /
  expired / refunded`) — the customer is notified in the app and by email.
* The order follows the intent:
  * **CAPTURED** → every order still waiting becomes **CONFIRMED** ("placed /
    paid", `paidAt` set, shop accept-by time, `order.placed` event, the
    customer's and shop's usual notices).
  * **FAILED / EXPIRED** → orders become **PAYMENT_FAILED** and the stock is
    released (same restock helper and ledger wording as a cancellation).
  * **Retry payment** (`POST /api/orders/<id>/pay`, the button on the return
    page) takes the stock again and opens attempt *n+1* for the same order(s).
    The key is `pay:<checkoutKey>:<n>` (`pay:group:<groupId>:<n>` for a
    multi-shop cart), so a double click shares one attempt and a customer can
    never pay twice: a paid order answers `alreadyPaid`, an open attempt is
    returned instead of a new one.
  * Cancelling an online order is refused while an attempt is open. A paid
    online order that is cancelled goes **CANCELLED → REFUND_PENDING**; the
    refund to the original method is queued and sent by the reconciliation
    job, then the order becomes **REFUNDED**.

## 3. Switching provider by configuration

| Env var | Meaning |
|---|---|
| `PAYMENT_GATEWAY` | `SANDBOX` (default) \| `CASHFREE` \| `RAZORPAY` \| `PHONEPE` \| `HDFC` |
| `PAYMENT_PUBLIC_BASE_URL` | public origin for return / webhook URLs (falls back to `AUTH_URL`) |
| `PAYMENT_WEBHOOK_SECRET_SANDBOX` | sandbox webhook secret (a fixed test secret is used outside production) |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` | Cashfree keys (the same ones the wallet top-up uses) |
| `PAYMENT_WEBHOOK_SECRET_CASHFREE` | optional; Cashfree signs webhooks with the API secret, which is the default |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `PAYMENT_WEBHOOK_SECRET_RAZORPAY` | Razorpay (scaffold) |
| `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, `PHONEPE_SALT_INDEX`, `PHONEPE_ENV` | PhonePe (scaffold) |
| `HDFC_BASE_URL`, `HDFC_MERCHANT_ID`, `HDFC_API_KEY`, `HDFC_PAYMENT_PAGE_CLIENT_ID`, `HDFC_RESPONSE_KEY`, `HDFC_WEBHOOK_USERNAME`, `HDFC_WEBHOOK_PASSWORD` | HDFC Bank SmartGateway (section 3a) |

A gateway without its keys is never used (`isConfigured()` false → online
payment is refused with "Online payment is not available"). The sandbox is
refused in production unless `PAYMENT_GATEWAY=SANDBOX` **and** rule
`onlinePayments.allowSandboxInProduction` is on.

Rule `onlinePayments` (Admin → Settings): `enabled` (default **false**),
`methods` (UPI / CARD / NETBANKING), `intentExpiryMinutes` (15),
`reconcileAfterMinutes` (10), `maxReconcileAttempts` (48),
`allowSandboxInProduction` (false).

Razorpay and PhonePe are scaffolds: endpoint shapes and signature checks follow
their published docs, but the parts marked **UNVERIFIED** in
`src/server/payments/gateway/razorpay.ts` / `phonepe.ts` must be checked in the
provider's test mode before use. Their checkout UI (Razorpay Checkout JS) is not
wired yet; Cashfree's is (`/orders/pay/session/<intent>`).

## 3a. HDFC Bank SmartGateway

`src/server/payments/gateway/hdfc.ts` (Juspay "Payment Page" API). The values come
from HDFC's onboarding kit (`config.json`); they go into the environment only,
never into code or the repository:

| Kit (`config.json`) | Env var |
|---|---|
| `BASE_URL` | `HDFC_BASE_URL` (UAT `https://smartgateway.hdfcuat.bank.in`) |
| `MERCHANT_ID` | `HDFC_MERCHANT_ID` |
| `API_KEY` | `HDFC_API_KEY` |
| `PAYMENT_PAGE_CLIENT_ID` | `HDFC_PAYMENT_PAGE_CLIENT_ID` |
| `RESPONSE_KEY` | `HDFC_RESPONSE_KEY` |
| — (set in the HDFC dashboard → Webhooks) | `HDFC_WEBHOOK_USERNAME`, `HDFC_WEBHOOK_PASSWORD` |

* Checkout: `POST /session` → the bank's hosted payment page (`HOSTED_URL`). Payment
  links use the same session API.
* The bank's `order_id` must be under 21 characters, so it is `GK` + 18 hex characters
  derived from our merchant order id (`hdfcOrderId`); it is stored as the gateway order id.
* Return: the bank sends the customer to `/api/payments/hdfc/return?to=<our page>`
  (GET or POST), which forwards to `/orders/payment-return?intent=…`. The return
  signature (`HDFC_RESPONSE_KEY`) is checked and only logged; the state always comes
  from `GET /orders/{order_id}`.
* Webhooks carry no body signature: they are authenticated by Basic auth only.
* A UAT `HDFC_BASE_URL` is refused on gokesari.com (`isConfigured()` false).
* Payment methods (cards, UPI, net banking) are switched on in the HDFC dashboard,
  not by rule `onlinePayments.methods`.

**UAT checklist (test.gokesari.com) before any production use** — the parts marked
UNVERIFIED in `hdfc.ts`:

1. Set the HDFC env vars with the UAT kit values, `PAYMENT_GATEWAY=HDFC`,
   `PAYMENT_PUBLIC_BASE_URL=https://test.gokesari.com`; restart the app.
2. Register `https://test.gokesari.com/api/webhooks/payments/hdfc` in the UAT
   dashboard with the Basic auth username / password.
3. Pay one order with HDFC's UAT test card / UPI / net banking (their `JP_DUMMY` /
   `NB_DUMMY` banks): the order is Confirmed; the webhook row shows outcome MOVED or NO_CHANGE.
4. A failed payment ends FAILED; one left open ends EXPIRED after `payments-reconcile`.
5. Cancel a paid order: the refund reaches SUCCESS (webhook or reconciliation).
6. Check the server log has no "return signature did not match".

## 4. Webhook URL to register at the gateway

```
https://<host>/api/webhooks/payments/cashfree     (Cashfree: Developers → Webhooks, PG "Payment" + "Refund" events, version 2023-08-01)
https://<host>/api/webhooks/payments/razorpay     (Razorpay: payment.captured, payment.failed, order.paid, refund.processed, refund.failed)
https://<host>/api/webhooks/payments/phonepe      (PhonePe: sent as callbackUrl with each payment)
https://<host>/api/webhooks/payments/hdfc         (HDFC SmartGateway dashboard → Webhooks, Basic auth = HDFC_WEBHOOK_USERNAME / _PASSWORD)
```

The existing wallet top-up webhook `/api/webhooks/cashfree` is unchanged and
separate. The notify URL is also sent with each Cashfree order.

Cron (add to the server crontab, `docs/event-driven-2026-10/crontab.test.txt` style):

```
*/5 * * * *  $HOME/gokesari-cron/run.sh payments-reconcile    # stuck intents, refunds, orphan orders
11 * * * *   $HOME/gokesari-cron/run.sh auth-housekeeping     # F1.1.2: purge old sign-in codes
```

## 5. Testing on staging (test.gokesari.com)

**Sandbox gateway (no keys needed):**

1. Admin → Settings → `onlinePayments` → `enabled: true` (leave `PAYMENT_GATEWAY` unset = SANDBOX).
2. As a customer, add items to the cart → **Pay with: Pay online (UPI / card / netbanking)** → Pay.
3. The sandbox page opens (`/orders/pay/sandbox/gk_…`): press **Pay (success)**, **Fail** or **Let it expire**.
   Each one posts a signed webhook through the real webhook handler.
4. You land on `/orders/payment-return?intent=…`: Paid → the order is Confirmed;
   Failed / Expired → **Retry payment** reuses the order.
5. Stuck payments: leave a payment open past `reconcileAfterMinutes`, run
   `payments-reconcile`, check it ends EXPIRED (or CAPTURED if paid).

**Cashfree sandbox** (`PAYMENT_GATEWAY=CASHFREE`, `CASHFREE_ENV=sandbox`, sandbox keys in the environment):
use only the test data in [testing/cashfree-sandbox-test-data.md](testing/cashfree-sandbox-test-data.md):

* Cards: Visa **4111 1111 1111 1111**, exp 12/30, CVV 123, OTP **111000** (proven); debit **4706 1312 1121 2123**.
* UPI: **testsuccess@gocash** (success), **testfailure@gocash** (failure).
* Net banking: bank code **3003** (proven); TEST Bank 3333 / TESTR.
* This build environment cannot reach Cashfree; run the pay step through the
  "Sandbox payment" GitHub workflow (`.github/workflows/sandbox-pay.yml`) or by hand on staging.

Never use real cards, UPI IDs or bank accounts on staging, and never sandbox keys on gokesari.com.

## 6. Going live (owner checklist)

1. Choose the gateway; open the merchant account; complete KYC.
2. Set on gokesari.com: `PAYMENT_GATEWAY`, that gateway's live keys, its webhook secret, `PAYMENT_PUBLIC_BASE_URL=https://gokesari.com`.
3. Register the webhook URL (section 4) with the gateway.
4. Add the `payments-reconcile` cron.
5. Test one small real payment and one refund.
6. Admin → Settings → `onlinePayments.enabled = true`.

## 7. For other workstreams

`createPaymentIntent`, `getPaymentIntent`, `findCapturedIntent`,
`refundPaymentIntent` (src/server/payments/intents.ts) keep the contract
signatures. `refundPaymentIntent(input)` sends the refund at once;
`refundPaymentIntent(input, tx)` records it in the caller's transaction and the
reconciliation job sends it after commit (an external refund is never made for a
change that could still roll back). Add a purpose's capture handler to
`CAPTURED_HANDLERS` and, if it needs one, a failure handler to
`PAYMENT_ENDED_HANDLERS` (src/server/payments/ended-handlers.ts).
