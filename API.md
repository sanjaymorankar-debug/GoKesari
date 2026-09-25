# API Reference

All endpoints return JSON. Errors use a single shape:

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "…", "details": { } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No active session |
| `FORBIDDEN` | 403 | Role or ownership check failed |
| `NOT_FOUND` | 404 | No such resource |
| `VALIDATION_FAILED` | 422 | Bad input; `details.fields` maps field → message |
| `CONFLICT` | 409 | State conflict |
| `INSUFFICIENT_BALANCE` | 402 | `details` has `requiredPaise`, `availablePaise`, `shortfallPaise` |
| `PRODUCT_NOT_PURCHASABLE_ONLINE` | 409 | Offline-only, inactive, or shop unapproved |
| `OUT_OF_STOCK` | 409 | Insufficient online stock |
| `INVALID_STATE_TRANSITION` | 409 | Illegal order status change |
| `PAYMENT_VERIFICATION_FAILED` | 400 | Signature invalid or payment not yours |
| `RATE_LIMITED` | 429 | `details.retryAfterSeconds` |
| `INTERNAL` | 500 | Unexpected; details are logged server-side only |

**All monetary values are integer paise. All quantities are integer
milli-units.** `₹70.00` is `7000`; `2 L` is `2000`.

Authentication is a session cookie from Auth.js. Sign in at `/signin`.

---

## Catalogue (public)

### `GET /api/catalogue`
Query: `department` (`DAIRY`|`BAKERY`), `categoryId`, `subscribable=true`
→ `{ categories: [...], products: [...] }`

### `GET /api/shops`
Public shop search. Only `APPROVED` shops are ever returned.

Query: `q`, `city`, `area`, `pincode`, `type` (`DAIRY`|`BAKERY`|`BOTH`),
`classification` (`KESARI`|`GREEN`), `delivery=true`, `limit`, `offset`

### `GET /api/shops/{id}/products`
Query: `onlineOnly=true` to restrict to online-purchasable offerings.

---

## Shops

### `POST /api/shops` — register
Requires `shop:create`. Always creates a shop with status `PENDING_APPROVAL`
and no classification; both are server-assigned and cannot be supplied.

```json
{
  "name": "Kesari Dairy",
  "ownerName": "Owner Name",
  "phone": "9876543210",
  "addressLine1": "1 Main Road",
  "city": "Pune",
  "pincode": "411038",
  "shopType": "DAIRY",
  "deliveryAvailable": true,
  "deliveryFeePaise": 2000
}
```

### `POST /api/shops/{id}/approve`
Requires `shop:approve` (Operator/Admin). Body: `{ "classification": "KESARI" | "GREEN" }`

### `POST /api/shops/{id}/reject`
Requires `shop:reject`. Body: `{ "reason": "…" }`

### `GET|POST /api/shops/{id}/classification`
Requires `shop:set-classification` — **not held by shop owners**.
`GET` returns the change history. `POST` body:
`{ "classification": "KESARI" | "GREEN", "reason": "…" }` (reason mandatory).

### `POST /api/shops/{id}/products`
Owner of the shop, or Operator/Admin. Enabling a channel requires that
channel's price.

```json
{
  "productId": "uuid",
  "onlineSaleEnabled": true,
  "onlinePricePaise": 7000,
  "offlineSaleEnabled": true,
  "offlinePricePaise": 6500,
  "trackInventory": true,
  "onlineStock": 100
}
```

### `PATCH /api/shop-products/{id}`
Same authorization. Any subset of the create fields. Price changes are written
to `product_price_history` and audit-logged in the same transaction.

### `PATCH /api/shops/{id}`
Owner (own shop) or `SHOP_UPDATE_ANY`. Any subset of the editable shop fields.
New: `serviceRadiusKm` (integer 1–50) — the shop's delivery zone in straight-line
km from its pin (GS-010). Audit-logged with the previous value.

## Location (customer)

### `POST /api/location` · `DELETE /api/location`
Sets the delivery location used for discovery (GS-004). Body is one of:
```json
{ "addressId": "uuid" }                       // own saved address — sign-in required
{ "latitude": 18.52, "longitude": 73.85 }     // device position, rounded to 4 decimals
{ "pincode": "411001" }
```
Stored in the httpOnly cookie `gk_location` (30 days); nothing is written to the
database and no Maps API is called. Returns the stored location. `DELETE`
clears it. Pages then list only shops that deliver there (`?all=1` shows all).

---

## Cart

### `GET /api/cart`
Returns the cart grouped by shop with live prices, per-shop delivery fees, and a
`purchasable` flag plus `unavailableReason` per line.

### `POST /api/cart`
`{ "shopProductId": "uuid", "quantity": 1 }` — validated against the *total*
resulting quantity, not just the delta.

### `PATCH /api/cart/items/{id}` · `DELETE /api/cart/items/{id}` · `DELETE /api/cart`

---

## Checkout & orders

### `POST /api/checkout`
```json
{ "requestId": "client-generated-stable-id", "addressId": null, "notes": null,
  "orderType": "PERSONAL", "buyerShopId": null }
```
`orderType: "B2B"` places a business order for `buyerShopId` — needs
`ORDER_PLACE_B2B` (shop owner/admin), the caller's own approved shop, and no cart
items from that same shop. Personal orders must not send `buyerShopId`.

Splits the cart into one order per shop, recomputes every price server-side,
consumes stock and debits the wallet — all atomically per shop.

Re-sending the same `requestId` returns the original orders with
`deduplicated: true` instead of charging again. Returns `402` with a shortfall
if the balance is insufficient; nothing is created and no stock is consumed.

### `GET /api/orders`

### `PATCH /api/orders/{id}/status`
`{ "status": "PREPARING", "note": "optional" }`

Shop staff may advance their own shop's orders; Operator/Admin may advance any.
A customer may cancel their own order. Cancelling a paid order refunds the
wallet idempotently. Illegal transitions return `409`.

Lifecycle: `PENDING → CONFIRMED (paid, shop pending) → ACCEPTED → PREPARING →
READY → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED`, with exceptions
`CANCELLED`, `FAILED`, `RETURNED`, `DISPUTED`, `PAYMENT_FAILED`,
`WALLET_INSUFFICIENT`, `REFUND_PENDING`, `REFUNDED`. Accepted targets here:
`PREPARING`, `READY` (runs the pack check + rider dispatch), `OUT_FOR_DELIVERY` /
`DELIVERED` (shop's own delivery, only before a rider is assigned), `CANCELLED`,
`RETURNED` (after a failed delivery), `DISPUTED` (operations only).

### `POST /api/orders/{id}/fulfilment` — shop fulfilment
Owner of the order's shop, or `ORDER_UPDATE_STATUS_ANY`. Body is one of:
```json
{ "action": "accept" }
{ "action": "reject", "reason": "Closed today" }
{ "action": "start" }
{ "action": "pick", "itemId": "uuid" }
{ "action": "substitute", "itemId": "uuid", "substituteShopProductId": "uuid", "note": "optional" }
{ "action": "remove", "itemId": "uuid", "reason": "Out of stock" }
{ "action": "ready" }
```
A substitute is charged at the lower of its price and the original line; a
removed line (or a cheaper substitute's difference) is refunded to the wallet
at once and deducted from the order total. `ready` fails while a substitution
awaits the customer. If every line is removed the order is cancelled.

### `PATCH /api/orders/{id}/items/{itemId}/substitution` — customer decision
`{ "approve": true }` keeps the substitute; `false` removes and refunds the item.
Only the customer who placed the order.

### `POST /api/orders/{id}/confirm-delivery` — operations override
`{ "proofNote": "Customer confirmed by phone at 18:40" }`. `DELIVERY_ORDER_MANAGE_ANY`.
Marks a picked-up delivery DELIVERED without the customer OTP; audited.

### `PATCH /api/delivery-orders/{id}` — rider actions
```json
{ "action": "accept" }                       // within 2 minutes of the offer
{ "action": "reject", "reason": "optional" }  // rider is never offered this order again
{ "action": "pickup", "pickupCode": "1234" }  // code the shop reads out
{ "action": "start" }                         // leaves the shop; issues the customer OTP
{ "action": "deliver", "otp": "5678" }        // customer's code; 5 wrong tries max
{ "action": "fail", "reason": "Customer not reachable" }
```
Responses never contain the pickup code or the OTP (only `needsPickupCode` /
`needsDeliveryOtp` flags). The shop sees the pickup code on its order list;
the customer sees the OTP on My Orders while the order is out for delivery.

### `POST /api/cron/delivery-dispatch`
`Authorization: Bearer $CRON_SECRET`. Run every minute. Expires unanswered
offers (2 min) and retries a rider for every READY order of a delivering shop
with nobody working on it. Returns `{ expired, attempted, offered }`.

---

## Society (Phase 2)

Society roles are scoped per society through membership (`ADMIN` / `OPERATOR`
/ `RESIDENT`); platform operators/admins (`SOCIETY_MANAGE_ANY`) can act on any
society. Society staff never see residents' contact details or order contents.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/societies?q=` · `POST /api/societies` | signed in / `SOCIETY_REGISTER` | Search verified societies; register one (caller becomes ADMIN, status APPLIED) |
| `GET /api/societies/mine` | signed in | Own memberships |
| `GET /api/societies/{id}` · `PATCH` | society ADMIN/OPERATOR (GET), ADMIN (PATCH) | Dashboard; rules: `deliveryInstructions`, `securityNotifyEnabled`, `exclusiveRiders`, `boundaryRadiusMeters`, coordinates |
| `POST /api/societies/{id}/decision` | `SOCIETY_MANAGE_ANY` | `{ decision: verify\|reject\|suspend\|reinstate, reason? }` |
| `POST /api/societies/{id}/members` | `SOCIETY_REGISTER` | Ask to join `{ unitLabel? }` (PENDING) |
| `PATCH /api/societies/members/{memberId}` | society ADMIN/OPERATOR; member (remove = leave) | `{ action: approve\|decline\|role\|remove, role? }` (role: ADMIN only; last admin protected) |
| `POST /api/societies/{id}/riders` · `PATCH /api/societies/riders/{linkId}` | society ADMIN | Add rider by mobile `{ mobile, preferred }`; `{ revoke?, preferred? }` |
| `POST /api/societies/{id}/shops` | society ADMIN | `{ shopId, active }` — shops recommended to residents |
| `PUT /api/addresses/{id}/society` | owner | `{ societyId \| null }` — only a verified society you actively belong to |

Integration: an order to a society-linked address stores `orders.society_id`;
dispatch applies the society's rider list (exclusive filter / listed and
preferred first); security staff are notified on rider acceptance when enabled;
the rider's active job shows the society's gate notes; society partner shops
count as delivering to residents; checkout refuses shops that do not deliver to
the chosen address (GS-026).

## Ratings (Phase 2)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/orders/{id}/rating` · `POST` | order's customer (`RATING_CREATE_OWN`) | Eligibility; `{ target: SHOP\|DELIVERY_PARTNER, score 1-5, comment? }` — DELIVERED orders only, within 30 days, once per target |
| `GET /api/shops/{id}/ratings` | public | Average, count, recent visible reviews (no customer identity) |
| `PATCH /api/ratings/{id}` | `RATING_MODERATE` | `{ hide, reason }` — hidden ratings leave the average |

## Subscriptions & issues (Phase 2)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/subscriptions/{id}/history` | owner / `SUBSCRIPTION_MANAGE_ANY` | Lifecycle events (paused, resumed, skipped, cancelled, payment failed) |
| `POST /api/orders/{id}/issue` | order's customer | `{ category: ORDER\|PRODUCT\|PAYMENT, description }` — grievance linked to the order |

Pause / resume / skip / cancel now refuse CANCELLED or COMPLETED subscriptions
(resume no longer revives a cancelled one).

## Finance (Slice 6)

Commission is a % of goods by shop type with per-shop overrides (D6); the
delivery fee is platform revenue and rider earnings a platform cost. Each
order gets an `order_financials` snapshot (GMV, promotional discount,
commission, shop payable) when it is DELIVERED, and every money event is
journalled in `finance_ledger_entries`. Settlements and payouts are weekly:
`PENDING → ELIGIBLE → PROCESSING → PAID | FAILED` (re-send from FAILED),
`PAID → REVERSED`, `PENDING/ELIGIBLE → CANCELLED`. **Nothing here transfers
money** — it records what an admin did at the bank.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET/POST /api/finance/commission-rates` | VIEW / MANAGE | List; set `{ scope: DEFAULT\|SHOP_TYPE\|SHOP, shopType?, shopId?, rateBp }` (500 = 5%) |
| `GET/POST /api/finance/settlements` | VIEW / PREPARE | List; prepare for `{ weekStart? }` (Monday, default last week) |
| `PATCH /api/finance/settlements/{id}` | MANAGE | `{ action: approve\|process\|pay\|fail\|reverse\|cancel, note? }` — note = UTR reference for pay, reason for fail/reverse |
| `GET/POST /api/finance/rider-payouts` · `PATCH …/{id}` | VIEW / PREPARE / MANAGE | Same, from unpaid earnings + rider adjustments |
| `POST /api/finance/refunds` | ORDER_REFUND | `{ orderNumber, amountPaise, reason, chargeTo: SHOP\|PLATFORM, requestId }` — full/partial/item refund of a DELIVERED/DISPUTED order to the wallet |
| `GET/POST /api/finance/adjustments` | VIEW / MANAGE | `{ type: SHOP_ADJUSTMENT\|RIDER_ADJUSTMENT\|DELIVERY_ADJUSTMENT\|MARKETPLACE_ADJUSTMENT, shopId?, deliveryPartnerId?, orderNumber?, amountPaise (±), reason, requestId }` |
| `GET /api/finance/summary?from&to` | VIEW | GMV, paid order value, gateway payments, wallet refunds, discounts, commission, delivery-fee revenue, rider cost, platform net |
| `GET /api/finance/payables` | VIEW | What each shop / rider is owed and not yet batched |
| `GET /api/finance/ledger?orderId\|entityType&entityId` | VIEW | Journal entries |
| `GET /api/finance/reconciliation?status=…` | VIEW or EXCEPTIONS | Records + counts (operators: ORDER/PAYMENT/RIDER only) |
| `POST /api/finance/reconciliation` | MANAGE | `{ from, to }` — run checks, store UNMATCHED/MATCHED/PARTIAL/EXCEPTION |
| `PATCH /api/finance/reconciliation/{id}` | VIEW or EXCEPTIONS | `{ note }` → RECONCILED (operators: operational records only) |
| `GET /api/finance/exceptions` | VIEW or EXCEPTIONS | Failed/pending payments, refunds pending, cancellations, delivery adjustments, open reconciliation; admins also failed/reversed batches and overdue settlements |
| `GET /api/finance/orders/{orderNumber}` | VIEW | Money trace: payment, wallet entries, snapshot, adjustments, journal, settlement, rider earning, reconciliation |
| `POST /api/cron/finance-weekly` | CRON_SECRET | Prepares last week's settlements + payouts; reconciles the last 35 days |

VIEW = `FINANCE_VIEW`, PREPARE = `FINANCE_PREPARE`, MANAGE = `FINANCE_MANAGE`
(all admin only). EXCEPTIONS = `FINANCE_EXCEPTIONS_VIEW` (operator + admin).
`ORDER_REFUND`: operator + admin. Shop owners: `/shop/finance`
(`SETTLEMENT_VIEW_OWN`); riders: earnings/payouts on `/delivery-partner`;
customers: their wallet (`/wallet`) and orders.

## Wallet

### `GET /api/wallet`
Balance, today's deductions, low-balance state, 15-day subscription forecast and
recent transactions.

### `POST /api/wallet/topup`
`{ "amountPaise": 500000 }` (min ₹1, max ₹1,00,000)

Creates a gateway order only — **no money moves**. Returns
`{ gatewayOrderId, paymentSessionId, cashfreeMode, amountPaise, mock }`.

### `POST /api/wallet/verify`
```json
{ "gatewayOrderId": "…" }
```

Independently confirms with Cashfree's own API whether this order was
actually paid — nothing the client posts here is trusted as proof of
payment, only which order to check. Idempotent on the gateway payment id, so
a replayed call returns `alreadyProcessed: true` without a second credit. If
Cashfree does not confirm payment, the payment is marked `FAILED` and
nothing is credited.

### `PATCH /api/wallet/settings`
`lowBalanceThresholdPaise`, `autoRechargeEnabled`, `autoRechargeTriggerPaise`,
`autoRechargeAmountPaise`. Enabling auto-recharge requires both a trigger and an
amount.

---

## Subscriptions

### `GET /api/subscriptions` · `POST /api/subscriptions`
```json
{
  "shopProductId": "uuid",
  "quantityMilli": 2000,
  "frequency": "DAILY",
  "weekdays": [],
  "startDate": "2026-08-20"
}
```
`weekdays` uses ISO days (Monday = 1) and is required for `WEEKLY`.

### `GET|PATCH|DELETE /api/subscriptions/{id}`
`PATCH` changes the standing subscription permanently. `DELETE` cancels with an
optional `reason`.

### `POST /api/subscriptions/{id}/override`
`{ "date": "2026-08-21", "quantityMilli": 3000 }`

Changes one date only; the schedule reverts to the standing quantity the next
day. `DELETE` with `{ "date": … }` restores the standard quantity.

### `POST /api/subscriptions/{id}/skip`
`{ "date": "2026-08-25" }` — no order, no deduction.

### `POST /api/subscriptions/{id}/pause` · `/resume`
`{ "from": "2026-08-25", "until": "2026-08-30" }` — inclusive of both ends.

### `GET /api/subscriptions/{id}/calendar?days=30`
Per-date `delivers`, `quantityMilli`, `reason`, `isOverridden`,
`estimatedCostPaise`, `generatedStatus`.

### `POST /api/subscriptions/{id}/retry`
`{ "date": "2026-08-20" }` — retries a day that failed for insufficient balance.

A past or already-processed date cannot be modified.

---

## Notifications

### `GET /api/notifications?unreadOnly=true`
### `PATCH /api/notifications` — `{ "id": "uuid" }` or `{ "all": true }`

---

## Cron

### `POST /api/cron/daily-orders`
`Authorization: Bearer $CRON_SECRET` (compared in constant time).
Optional body: `{ "date": "YYYY-MM-DD", "subscriptionIds": ["uuid"] }`

```json
{
  "date": "2026-08-20",
  "generated": 12,
  "skipped": 3,
  "alreadyExisted": 0,
  "walletFailures": 1,
  "unavailable": 0,
  "errors": []
}
```

Idempotent per `(subscription, date)`. `GET` with the same header is a health
probe that generates nothing.

---

## Rate limits

| Scope | Limit |
|---|---|
| Payment create/verify | 10 / minute / user |
| Checkout | 15 / minute / user |
| Cron | 30 / minute / IP |

Exceeding a limit returns `429` with `details.retryAfterSeconds`.
