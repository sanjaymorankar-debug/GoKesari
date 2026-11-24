# PAY-2: wallet top-ups through payment intents (24-Nov-2026)

GoKesari took online payments through two Cashfree stacks, each with its own webhook:

| | Older top-up stack | Payment intents |
|---|---|---|
| Used for | customer wallet top-ups, shop wallet recharges | orders, registration fees, Health, consults, franchise, dealer fees, … |
| Create | `createTopUpOrder` / `createShopWalletTopUpOrder` call Cashfree directly | `createPaymentIntent` (any gateway in `PAYMENT_GATEWAY`) |
| Webhook | `/api/webhooks/cashfree` | `/api/webhooks/payments/<gateway>` |
| Status lookup | `cashfreeTopUpState` (Get Payments API) | `reconcileIntent` → `gateway.fetchOrder` |
| Sweep | `reconcileCashfreeTopUps` | `runPaymentReconciliation` |

PAY-2 routes top-ups through payment intents, so there is one create path, one webhook and one
status lookup. It sits behind the rule **`topupPaymentIntents`** (`{ enabled }`, **off by default**).
With the rule off nothing changes.

## Design

The `payments` row stays the anchor of a top-up. The wallet ledger (`wallet_transactions.payment_id`),
voucher redemptions, the shop wallet ledger and the finance reports all point at it, so it is kept.
A top-up started with the rule on has:

| Row | Value |
|---|---|
| `payments.gateway` | `INTENT` (the older Cashfree code skips these rows) |
| `payments.gateway_order_id` | the intent's `merchant_order_id` (`gk_…`, which is also Cashfree's order id) |
| `payment_intents.purpose` | `WALLET_TOPUP` or `SHOP_WALLET_TOPUP` (new, migration 0185) |
| `payment_intents.reference_id` | `payments.id` |
| `payment_intents.idempotency_key` | `topup:<payments.id>` |

### Flow (rule on)

1. **Create.** `createTopUpOrder` checks the amount limits and the voucher as before, then
   `startTopUpViaIntent` (`src/server/payments/topup-intents.ts`) inserts the `payments` row and calls
   `createPaymentIntent`. The gateway call happens there, outside any transaction of ours. If the
   gateway refuses, the row is marked FAILED.
2. **Pay.** On Cashfree the response carries `paymentSessionId`, and the wallet page opens the
   Cashfree SDK as before. On any other gateway (the sandbox on test.gokesari.com, or a hosted page) it
   carries `redirectUrl`. The browser goes there and comes back to `/orders/payment-return?intent=…`.
3. **Capture.** `CAPTURED_HANDLERS.WALLET_TOPUP / SHOP_WALLET_TOPUP` → `onTopUpCaptured`, inside the
   transaction that marks the intent CAPTURED:
   - `payments` CREATED → SUCCESS (a conditional UPDATE, so this happens once);
   - the credit: wallet `TOP_UP` keyed `topup:<gateway payment id>`, or shop wallet keyed
     `shop-topup:<…>` (`creditShopWalletTopUp` now takes the caller's transaction, as a savepoint);
   - the audit line.

   After the commit, in the same request: the notification, the voucher bonus (opportunistic, as
   before) and the subscription "payment due" refresh.
4. **Failure or expiry.** `PAYMENT_ENDED_HANDLERS` → `onTopUpEnded`: `payments` CREATED → FAILED.
5. **Late capture.** The gateway takes the money after the attempt failed or expired. A new
   `LATE_CAPTURE_HANDLERS` registry (`purpose-handlers.ts`, called from the LATE_CAPTURE branch of
   `applyGatewayState`) lets a top-up still be credited: `payments` FAILED → SUCCESS plus the
   credit, the same as the older `recoverLateTopUp`. The intent stays FAILED / EXPIRED.
   Purposes without an entry, such as orders, still go to support as before.
6. **Status lookup.** `/api/wallet/verify` and `/api/shops/[id]/wallet/verify` call
   `verifyAndCreditTopUp`. For an `INTENT` row this calls `reconcileIntent(intent, "API")`: the
   gateway's own answer moves the intent, and the capture handler credits the wallet. It then reads
   the result back. The return page and the `payments-reconcile` cron
   (`runPaymentReconciliation`) use the same path.

### The older webhook URL (`/api/webhooks/cashfree`)

The old URL keeps working:

- It checks the signature first, as before.
- Registration fees (`reg_…` orders) are handled first, unchanged.
- **Thin forwarder.** If the event's `order_id` belongs to a top-up intent, the raw body and headers
  go unchanged to `handlePaymentWebhook("cashfree", …)`, the same function behind
  `/api/webhooks/payments/cashfree`. Its signature check, its de-duplication
  (`payment_webhook_events`) and the gateway's own order state decide. The body is only a trigger.
- Older top-ups (`topup_…` / `shoptopup_…` orders) still go through `creditFromWebhook` exactly as
  before, whatever the rule says.
- If `creditFromWebhook` is ever reached for an `INTENT` row, it confirms through the intent and never
  credits from the body.

New intent-routed orders send `notify_url` = `/api/webhooks/payments/cashfree`. A webhook set in the
Cashfree dashboard to the old URL also reaches the same pipeline through the forwarder, and the
de-duplication absorbs the second copy.

## Migration plan for existing pending rows

**Existing rows are not converted.** A `payments` row with `status = 'CREATED'` and `gateway` `CASHFREE`
(or `MOCK` in development) was opened at Cashfree with a `topup_…` order id and the old `notify_url`.
Turning it into an intent would mean inventing a gateway order the intent stack never opened. Each
such row instead finishes on the path it started on:

| Way it completes | Still active after the switch? |
|---|---|
| Customer's verify call (`verifyAndCreditTopUp`, older branch) | yes: only `INTENT` rows take the new branch |
| Cashfree webhook to the old URL (`creditFromWebhook`) | yes: only top-up intents are forwarded |
| `payments-reconcile` job (`reconcileCashfreeTopUps`) | yes: it picks rows with `gateway = 'CASHFREE'` from 10 minutes to 72 hours old |
| Late payment after FAILED (`recoverLateTopUp`) | yes |

The older Cashfree order expires after 60 minutes. The reconcile job keeps asking about a pending UPI
payment for 24 hours, and looks back 72 hours in all. So **72 hours after the rule is switched on,
no older top-up can still be open.**

Steps:

1. Switch the rule on (Admin → Rules → `topupPaymentIntents`), staging first.
2. Before and after, count the open older rows:
   ```sql
   SELECT gateway, status, count(*), min(created_at), max(created_at)
   FROM payments
   WHERE status = 'CREATED'
   GROUP BY 1, 2;
   ```
   Rows with `gateway = 'INTENT'` are the new kind. Check that each has an intent:
   ```sql
   SELECT p.id, p.status AS payment_status, pi.status AS intent_status
   FROM payments p
   LEFT JOIN payment_intents pi
     ON pi.reference_id = p.id AND pi.purpose IN ('WALLET_TOPUP', 'SHOP_WALLET_TOPUP')
   WHERE p.gateway = 'INTENT' AND p.created_at > now() - interval '3 days';
   ```
   A row with no intent and a `gateway_order_id` of `intent_pending_…` means the process stopped
   between the two inserts. No money moved (no gateway order exists), so mark it FAILED.
3. After 72 hours, `CREATED` rows with `gateway IN ('CASHFREE', 'MOCK')` older than 72 hours should
   number 0. The reconcile job marks leftovers FAILED, and they move no money.
4. **Follow-up (not in this PR):** once the rule has been on in production for a while without
   trouble, remove the older create / verify / reconcile code. Keep `creditFromWebhook` and the old
   URL as the forwarder for as long as Cashfree may still deliver there (dashboard webhooks,
   retries).

## Turning it off

Switch the rule off. New top-ups go back to the older flow at once. Routed top-ups already open
still finish through their intents, because the verify, webhook and reconcile branches key on
`payments.gateway = 'INTENT'`, not on the rule. Migration 0185 only widens a CHECK constraint and
stays. `scripts/rollback-0185-topup-intents.sql` narrows it again, and refuses while any top-up intent
exists.

## Behaviour differences to know about (rule on)

- **Amount check.** An intent must be captured for exactly its amount (`applyGatewayState`). The older
  flow accepted more than the top-up and credited the top-up amount. A mismatch goes to support
  (`payment.attention`) and credits nothing.
- **Failed top-ups.** A failed top-up does not run `checkRiskForUser(…, "PAYMENT_FAILED")`. Ended
  handlers have no after-commit hook. Intent failures are recorded as `payment.failed` events.
- **Customer messages.** Customers get the intent's `payment.*` messages plus "Wallet topped up".
- **Gateway.** Top-ups use whichever gateway `PAYMENT_GATEWAY` selects. On test.gokesari.com
  (`SANDBOX`) that is the built-in sandbox page. Pay there with "Pay (success)".

## Files

| File | Change |
|---|---|
| `src/server/payments/topup-intents.ts` | new: create, capture / ended / late-capture handlers, status lookup |
| `src/server/services/payments.ts` | rule check in the two create functions; `INTENT` branches in verify, mock settle and `creditFromWebhook` |
| `src/app/api/webhooks/cashfree/route.ts` | forwarder for top-up intents |
| `src/server/payments/purpose-handlers.ts`, `ended-handlers.ts` | entries for the two purposes; `LATE_CAPTURE_HANDLERS` |
| `src/server/payments/processing.ts` | 4 lines in the LATE_CAPTURE branch |
| `src/server/services/shop-wallet.ts` | `creditShopWalletTopUp(input, client?)` |
| `src/server/config/rules.ts` | rule `topupPaymentIntents` |
| schema / `payment-intent-states.ts` / `intents.ts` | the two purposes |
| `drizzle/0185_topup_payment_intents.sql` | purpose CHECK widened (dynamic, re-runnable) |
| wallet top-up routes and the two top-up components | `redirectUrl` |
| `tests/integration/topup-payment-intents.test.ts` | 13 cases: rule off; rule on (create, webhook, redelivery, status lookup, failure, late capture, reconcile job, shop recharge); old URL (forward, body-is-only-a-trigger, forged signature, older top-up in flight) |

## Testing on staging

1. Switch on `topupPaymentIntents` on test.gokesari.com.
2. Wallet → Add money → sandbox page → "Pay (success)". The return page should say Paid, and the
   wallet should show the credit once.
3. Repeat with "Fail": the payments row should be FAILED and nothing credited.
4. Shop wallet recharge (rule `shopWallet` on): the same steps.
5. Switch the rule off again, unless the owner says to keep it on.
