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
Query: `department` (`DAIRY`|`BAKERY`), `categoryId`, `subscribable=true`,
`limit` (1–100, default 100), `offset`
→ `{ categories: [...], products: [...] }` — public columns only (no creator,
approver or review notes). Products are paged; categories come whole.

### `GET /api/shops`
Public shop search. Only `APPROVED` shops are ever returned, with the fields a
shop card shows: `id`, `slug`, `name`, `logoUrl`, `ownerName`, `area`, `city`,
`pincode`, `shopType`, `classification`, `deliveryAvailable`, `openingHours`,
`ratingAvgX100`, `ratingCount`.

Query: `q`, `city`, `area`, `pincode`, `type` (`DAIRY`|`BAKERY`|`BOTH`),
`classification` (`KESARI`|`GREEN`), `delivery=true`, `limit`, `offset`

### `GET /api/shops/{id}`
The shop's owner, or staff with `shop:update:any`: the shop's details in any
status. Anyone else: an `APPROVED` shop's card fields (as in `GET /api/shops`);
404 for a shop that is not live.

### `GET /api/shops/{id}/products`
The shop's owner, or staff with `shop-product:manage:any`: every listing with
its stock settings; `onlineOnly=true` to restrict to online-purchasable
offerings. Anyone else: an `APPROVED` shop's active online listings as the
storefront shows them, `limit` (1–100, default 100) and `offset`; 404 for a
shop that is not live.

---

## Shops

Shops returned by the owner's and staff's routes below never include the PAN
ciphertext or its hash, the Shop Act matching key, or staff and internal ids
(`approvedBy`, `gstVerifiedBy`, `panVerifiedBy`, `statusActorId`,
`registrationFeeId`, `referralCodeId`). The masked PAN is `panLast4`.

### `POST /api/shops` — register
Requires `shop:create`. Always creates a shop with status `PENDING_APPROVAL`
and no classification; both are server-assigned and cannot be supplied.

At least one of `shopActNumber`, `panNumber` or `udyamNumber` is required
(422 with all three fields highlighted otherwise). `panHolderName` is required
with `panNumber`. Values are normalised before they are stored or compared
(`src/lib/shop-identity.ts`): case, spaces, hyphens and slashes don't matter;
PAN must be `AAAAA9999A`; Udyam is stored as `UDYAM-XX-00-0000000`, an old
Udyog Aadhaar number as e.g. `MH26A0012345`, and a bare 12-digit number is
refused (it cannot be told apart from a personal Aadhaar number). The PAN is
stored encrypted and compared only through a keyed hash.

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
  "deliveryFeePaise": 2000,
  "shopActNumber": "PII/KOTHRUD/II/12345",
  "panNumber": "ABCDE1234F",
  "panHolderName": "Owner Name",
  "udyamNumber": "UDYAM-MH-26-0012345"
}
```

Duplicate registrations (`src/server/services/shop-duplicates.ts`):

| Existing registration | Matched on | Result |
|---|---|---|
| Pending, approved, suspended or inactive | same Shop Act licence; or same PAN / Udyam at the same place (same PIN code and same shop name or first address line); or the same account's shop of the same name at the same PIN code | **409** `CONFLICT`, nothing written |
| Rejected, same account | any of the above | **200**, that registration is updated and back in `PENDING_APPROVAL` (same id and registration number), `"resubmitted": true` |
| Rejected, another account | — | ignored: a new registration is created (**201**) |

A 409 body names the identifier that matched (masked) and the existing
registration's state, and never anything else about that shop:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "PAN number already registered (XXXXXX234F). This shop is already registered and is waiting for admin approval. You'll be notified once it's reviewed. You don't need to submit again.",
    "details": {
      "reason": "DUPLICATE_SHOP",
      "matchedOn": "PAN",
      "shopStatus": "PENDING_APPROVAL",
      "fields": { "panNumber": "PAN number already registered (XXXXXX234F)" }
    }
  }
}
```

`matchedOn` is one of `SHOP_ACT`, `PAN`, `UDYAM`, `NAME_AND_PIN`. An operator
registering on someone's behalf also gets `matchedShopId` and
`matchedRegistrationNumber`. Two simultaneous submissions of the same shop are
serialised by the server, so a double-click creates one registration.

### `POST /api/shops/duplicate-check`
Requires `shop:create`; rate-limited to 20 a minute per user. The registration
form's early warning — the same rules as registration, advisory only (the
registration re-checks). Body: any of `shopActNumber`, `panNumber`,
`udyamNumber`, plus `name`, `addressLine1`, `pincode` for the same-place rules.
Returns `{ "status": "CLEAR" }`,
`{ "status": "RESUBMISSION", "message": "…" }` (the caller's own rejected
registration), or
`{ "status": "DUPLICATE", "matchedOn", "field", "fieldMessage", "shopStatus", "message" }`.
A badly formatted number is a 422 with `details.fields`.

### `POST /api/shops/{id}/approve`
Requires `shop:approve` (Operator/Admin). Body: `{ "classification": "KESARI" | "GREEN" }`.
Notifies the owner. 409 if the shop was rejected and its Shop Act licence is
now held by another live registration.

### `POST /api/shops/{id}/reject`
Requires `shop:reject`. Body: `{ "reason": "…" }`. Notifies the owner, who
can correct the details and resubmit.

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

## Shop product photos & descriptions (Module 1)

Details, limits and error reasons: [docs/three-modules-2026-10/MODULE1_SHOP_PRODUCT_MEDIA.md](docs/three-modules-2026-10/MODULE1_SHOP_PRODUCT_MEDIA.md).
Every route below: the shop's owner, its staff (`shop_staff`) or operators/admins; anyone else 403, another shop's product 404.

| Method & path | |
|---|---|
| `GET /api/shops/{id}/listings/{listingId}/media` | Photos (main first), short/long description, master fallback, what customers see, limits |
| `PATCH /api/shops/{id}/listings/{listingId}/media` | `{ shortDescription?, longDescription? }`; `null` or `""` clears (master's text shows) |
| `POST /api/shops/{id}/listings/{listingId}/media/photos` | multipart `file` (JPG/PNG/WebP ≤ 5 MB), optional `replaceImageId` → 201 `{ id, url, isPrimary, moderationStatus }`. 422 `details.reason`: `PHOTO_TOO_LARGE`, `PHOTO_BAD_TYPE`, `PHOTO_UNREADABLE`, `PHOTO_TOO_SMALL`, `PHOTO_TOO_MANY_PIXELS`, `PHOTO_LIMIT` |
| `PUT /api/shops/{id}/listings/{listingId}/media/photos/order` | `{ imageIds }` — every photo once; the first is the main photo → 204 |
| `DELETE /api/shops/{id}/listings/{listingId}/media/photos/{imageId}` | → 204; the next photo becomes main if needed |
| `GET /api/shops/{id}/listings/{listingId}/media/history` | `{ changes: [{ at, summary, actorName, via: OWNER/STAFF/SUPPORT }] }` |
| `GET /api/shops/{id}/media-imports` · `POST` | List · multipart `zip` and/or `csv`, `photoMode` REPLACE/ADD → 201 preview (nothing applied) |
| `GET /api/shops/{id}/media-imports/{importId}` · `DELETE` | Preview/progress · cancel before applying |
| `POST /api/shops/{id}/media-imports/{importId}/apply` | 202; applies right after the response; resumes a stalled apply; 409 while running/finished |
| `GET /api/shops/{id}/media-imports/template` | CSV template |
| `GET /api/shops/{id}/staff` · `POST { identifier }` · `DELETE …/staff/{staffId}` | Owner (or support) manages staff by mobile/email |
| `GET /api/images/{id}?size=thumb\|medium\|large` | Existing route; processed photos' WebP copies, `ETag`/304 |

`GET /api/shops/{id}/products` (storefront) items gain `shortDescription` (the shop's, else the master's).

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

`scheduledSlots: { "<shopId>": "YYYY-MM-DD@HH:MM" }` (GS-027, rule
`scheduledSlots`) books a chosen time slot for that shop's order. The slot is
re-checked under a lock: a slot that has just filled returns `409`; one that
is past, inside the cut-off or not offered returns `422`. Shops without a chosen slot keep today's behaviour.

### `GET /api/checkout/scheduled-slots?shopId=`
GS-027. The slots a customer can choose for one shop: `{ enabled, slots:
[{ key, date, start, end, label, remaining }] }` (`remaining: null` = no limit). It lists only
future slots inside the shop's hours, after the cut-off, with places left.

### `GET /api/orders/{id}/invoice` · `POST`
NEW-007 (rule `invoicing`). Returns the order's invoice, issuing it if a delivered
order has none yet. Open to the order's customer, its shop's owner and operations.
`POST` returns the invoice JSON; `GET` redirects (`303`) to `/invoices/{invoiceId}`.

### `GET /api/invoices/{id}/pdf`
The invoice as a PDF attachment. Anyone other than the customer, the shop owner
and operations gets `404`.

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
{ "action": "deliver", "otp": "5678" }        // customer's code; rule deliveryOtp.maxAttempts wrong tries max
{ "action": "fail", "reason": "Customer not reachable" }
```
Responses never contain the pickup code, the OTP or its hash (only
`needsPickupCode` / `needsDeliveryOtp` / `deliveryCodeLocked` flags). The shop
sees the pickup code on its order list.

Delivery code (docs/shop-wallet-delivery-otp-2026-10): `start` stores only a
salted HMAC of a new 4-digit code and emails the code to the customer. On
`deliver`, only the rider holding the delivery may enter it (`403` otherwise).
A wrong code is `422` with `details.attemptsLeft`; the attempt that reaches
`deliveryOtp.maxAttempts` locks the drop — `409` with
`details: { locked: true, ticketNumber }` — raises a support ticket (grievance,
category ORDER) and alerts the customer, the shop and support; operations then
confirm it (`POST /api/orders/{id}/confirm-delivery`). A right code completes
the order and spends the code in one transaction; with rule `shopWallet` on,
the same transaction debits the shop wallet. Submitting again after success
returns the delivered row and charges nothing more.

### `POST /api/orders/{id}/delivery-code` — customer: new delivery code
Only the order's own customer (`404` for anyone else), only while the drop is
under way and not locked. Issues a fresh code (the previous one stops
working), emails it, and returns it once:
`{ code, sentTo, resendsLeft, nextRequestAt }`. Limited by rule `deliveryOtp`:
`resendCooldownSeconds` (default 60) between requests and `maxResends`
(default 3) per delivery — `429` with `details.retryAfterSeconds` otherwise.
The code itself is never stored.

### `POST /api/delivery-orders/{id}/proof`
NEW-007 (rule `deliveryProof`). Multipart `file`: the rider's photo at the
door (JPEG, PNG or WebP, within the image size limits, checked from the
bytes). Only the rider holding the picked-up delivery may upload. Returns
`201 { id, url }`. While the rule is on, `{ "action": "deliver" }` returns
`409` until a photo exists.

### `POST /api/delivery-orders/{id}/location` — live tracking
Event layer. `{ latitude, longitude }` from the rider's phone every
`tracking.riderPingSeconds` (default 5) while the drop is under way. Only the
rider holding the delivery may post (`403` otherwise). Before the drop starts
and once it is delivered, failed or cancelled nothing is stored and the answer
is `{ sharing: false }`; otherwise `{ sharing: true, shared, nextPingSeconds }`.

### `GET /api/tracking/{orderId}`
The order's tracking panel for its customer, its shop, staff and the rider
holding it. The rider's location is included only from the start of the drop
(`stage: IN_PROGRESS`) until the order is delivered or cancelled
(`stage: ENDED`); `AWAITING_START` means collected but not yet on the way.
`pollSeconds` (rule `tracking.buyerPollSeconds`, default 5) is how often an
open map refreshes.

### `POST /api/cron/delivery-dispatch`
`Authorization: Bearer $CRON_SECRET`. Run every minute. Expires unanswered
offers (2 min) and retries a rider for every READY order of a delivering shop
with nobody working on it. Returns `{ expired, attempted, offered }`.
**Superseded by `timeout-sweep`** (event layer); kept for rollback.

### `POST /api/cron/timeout-sweep` — event layer safety net
`Authorization: Bearer $CRON_SECRET`. Run every minute; `GET` is a readiness
probe. Only what depends on time passing: shop acceptance reminder and timeout
(X = `shopAcceptance.acceptMinutes`, CANCEL or ESCALATE), unanswered rider
offers and dispatch retries, the "no rider within Y minutes" support alert
(`dispatch.alertSupportAfterMinutes`), return pickups, and "shop is open now"
alerts. Returns `{ shopAcceptance, dispatch, riderSearchAlerts, returnPickups, shopOpening, errors }`.

### `POST /api/cron/notification-retry` — event layer safety net
`Authorization: Bearer $CRON_SECRET`. Run every minute; `GET` is a readiness
probe. Retries failed outbound notifications from the outbox
(`notification_deliveries`) up to N = `notifications.maxAttempts`, then marks
them DEAD and alerts support in the app. Returns `{ sent, failed, skipped, dead }`.

### Disputes — `POST /api/disputes`, `GET|PATCH /api/disputes/{id}`, `POST /api/disputes/{id}/comments`
Event layer. Opening (`imageIds` optional — photos uploaded first to
`POST /api/images` with `purpose=DISPUTE_EVIDENCE`) returns the case with its
`DSP-` number and notifies the shop and support at once. The case's customer,
shop and staff may `GET` it and comment
(`{ body, imageIds?, internal? (staff only), clientRequestId }` — a repeated
`clientRequestId` posts once). `PATCH { action: "advance" }` is staff's, except
that the shop may move a triaged case to `RESOLUTION_PROPOSED` with a
`proposal`; `escalate` and `resolve` are staff-only. Every change notifies the
other parties.

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

## Roles (Phase 3 — GS-003)

A user can hold several roles; `users.role` is the active one used by every
permission check. CUSTOMER is implicit. Shop registration, rider application
and society administration grant their role alongside any role already held.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/me/roles` · `PUT` | signed in | Held roles and the active one; `{ role }` switches to a held role |
| `GET /api/users/{id}/roles` · `DELETE ?role=` | `USER_SET_ROLE` (admin) | Grants; revoke one (falls back to CUSTOMER if it was active) |
| `PATCH /api/users/{id}/role` | `USER_SET_ROLE` | Unchanged API — now grants + activates; staff roles (OPERATOR/ADMIN) are exclusive |

## Cash on delivery (Phase 3 — GS-030)

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/checkout` `{ paymentMethod: "COD" }` | customer | Personal orders to a saved address; shop must opt in; ≤ ₹2,000 per order; ≤ 2 open COD orders; paused after 2 failed COD deliveries in 90 days or an open HIGH risk flag |
| `GET /api/cod/eligibility` | customer | Whether COD is available and why not |
| `PATCH /api/shops/{id}` `{ codEnabled }` | shop owner | Opt in / out |
| `PATCH /api/delivery-orders/{id}` `{ action: "deliver", otp, cashCollected: true }` | rider | Required for COD orders |
| `POST /api/orders/{id}/confirm-delivery` `{ proofNote, cashCollected: true }` | operations | Required for COD orders |
| `GET /api/admin/cod` · `POST` | `COD_CASH_MANAGE` | Cash held per rider / shop; record a deposit `{ party, id, amountPaise, reference, requestId }` |

On delivery the order becomes paid and a `COD_CASH_COLLECTED` adjustment (−total)
is recorded against the collector (rider, or the shop when it delivers itself);
a deposit adds `COD_CASH_DEPOSITED` (+). Whatever is still held is netted in the
next weekly payout / settlement. Refunds of COD orders are wallet credits.
Reconciliation counts collected cash as payment.

## Analytics (Phase 3 — GS-069, KPI-001…015)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/analytics/kpis?from=&to=&shopId=` | `REPORT_VIEW_ALL` / `REPORT_VIEW_OPERATIONAL`; shop owner for own `shopId` | KPI set for the window (default last 30 days). Definitions in `src/server/services/analytics.ts` |

## Marketing (Phase 3 — GS-052/053, WF-009, KPI-015)

Shops only ever see counts, never customer identities; only customers with
marketing consent are messaged.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET/POST /api/shops/{id}/marketing/segments` | owner (`MARKETING_MANAGE_OWN`); operations view | List with audience counts; create; `{ preview: true, rules }` previews |
| `PATCH/DELETE /api/shops/{id}/marketing/segments/{segmentId}` | owner | Edit / delete (not while a live campaign uses it) |
| `GET/POST /api/shops/{id}/marketing/campaigns` | owner; operations view | List with results; create a draft |
| `PATCH /api/shops/{id}/marketing/campaigns/{campaignId}` | owner | `{ action: update\|submit\|send\|cancel }` |
| `GET /api/admin/campaigns?status=` · `POST /api/admin/campaigns/{id}/decision` | `MARKETING_APPROVE` | Review queue; `{ decision: approve\|reject, reason }` |

Limits: 2 campaigns per shop per 7 days; a customer receives at most 1 campaign
per shop and 3 in total per 7 days; budget = max recipients (1–5,000).

## Risk (Phase 3 — GS-068)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/admin/risk?status=&severity=&subjectType=` · `POST` | `RISK_REVIEW` | Flags (default OPEN; optional severity `HIGH\|MEDIUM\|LOW`, subjectType `USER\|SHOP\|DELIVERY_PARTNER`), each with `subjectName`, `subjectStatus` (the subject's current account status) and `subjectIsAdmin` (a USER flag on an admin account, which cannot be suspended); run the rules now |
| `PATCH /api/admin/risk/{id}` | `RISK_REVIEW` | `{ decision: DISMISSED\|ACTIONED, note }` |
| `POST /api/cron/risk-rules` | cron (`CRON_SECRET`) | Hourly rules sweep |
| `POST /api/shops/{id}/suspend` | `SHOP_SUSPEND` (operator, admin) | `{ reason }` — APPROVED → SUSPENDED in one conditional update (a concurrent reject or suspend gets 409); audited `shop.suspended`. The shop leaves the storefront and stops taking orders. Open orders are not cancelled or refunded, the shop's subscriptions stay active (each subscriber is told daily their delivery is unavailable), and the owner is not notified: the reason is in the audit log only. Re-approve with `POST /api/shops/{id}/approve` |
| `POST /api/users/{id}/suspend` | `USER_SUSPEND` (admin) | `{ reason }` — ACTIVE → SUSPENDED; audited `user.suspended`. Refused (403) for your own account and for any admin: an ACTIVE ADMIN role grant (not just the active role), the active role ADMIN or a `PERMANENT_ADMIN_EMAILS` address. The user can no longer sign in (`/signin?error=AccessDenied` explains why) and existing sessions stop working. An APPROVED delivery-partner profile of the user is suspended first through the delivery-partner suspend (offline, notified); a delivery it was carrying stays assigned until operations resolves it. Subscriptions and shops the user owns are not paused |
| `POST /api/users/{id}/reinstate` | `USER_SUSPEND` (admin) | `{ reason }` — SUSPENDED → ACTIVE (409 otherwise, 404 if unknown); audited `user.reinstated`. Restores the account only: a delivery-partner profile suspended with it stays SUSPENDED until `PATCH /api/delivery-partner/{id}` `{ action: "reactivate" }`, and a suspended shop needs its own re-approval. No screen yet |

The `/admin/risk` page offers "Suspend & mark actioned" on open flags: it calls the
subject's suspend endpoint (`PATCH /api/delivery-partner/{id}` `{ action: "suspend", reason }`
for riders), then closes the flag as ACTIONED with the note `Suspended: <reason>`. A rider is
shown the reason (it is their suspension notice), so the page says so; if another reviewer
closed the flag first, the page says the suspension worked and the flag was already closed.

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

### Shop wallet (rule `shopWallet`, docs/shop-wallet-delivery-otp-2026-10)

A shop's prepaid wallet. When the rule is on, a delivered order's commission
(rates from `commission_rates`) and `shopWallet.deliveryChargePaise` (orders a
GoKesari rider delivered) are debited from it in the delivery's own
transaction, as two ledger entries linked to the order, and settlement no
longer withholds that commission. Below `minBalancePaise` the shop cannot
accept a new order: `POST /api/orders/{id}/fulfilment {action:"accept"}`
returns `402 INSUFFICIENT_BALANCE` with
`details: { balancePaise, minBalancePaise, rechargeUrl: "/shop/wallet" }`.
The balance changes only through ledger entries (enforced by the database).

#### `GET /api/shops/{id}/wallet?limit=50&offset=0`
The shop's owner, or finance staff. `{ enabled, balancePaise, minBalancePaise,
lowBalanceThresholdPaise, canAcceptOrders, lowBalance, commissionRateBp,
deliveryChargePaise, topupMinPaise, topupMaxPaise, transactions[] }` — each
entry `{ type, direction, amountPaise, balanceBeforePaise, balanceAfterPaise,
orderId, orderNumber, reason, createdAt }`.

#### `POST /api/shops/{id}/wallet/topup` — `{ "amountPaise": 100000 }`
Shop owner only (staff use `adjust`). Limits `topupMinPaise`/`topupMaxPaise`;
`409` while the rule is off. Creates a gateway order only — no money moves.
Returns `{ gatewayOrderId, paymentSessionId, cashfreeMode, amountPaise, mock }`.

#### `POST /api/shops/{id}/wallet/verify` — `{ "gatewayOrderId": "…" }`
Confirms with Cashfree and credits the shop wallet; idempotent on the gateway
payment id (the Cashfree webhook credits shop recharges too). In mock mode use
`POST /api/dev/settle-topup`. Returns `{ success, balancePaise, alreadyProcessed }`.

#### `POST /api/shops/{id}/wallet/adjust` — administrators (`WALLET_ADJUST`)
`{ direction: "CREDIT" | "DEBIT", amountPaise, reason, requestId }`. A manual
ledger entry (e.g. a recharge paid in cash); a debit never overdraws; the same
`requestId` adjusts once. The owner is notified.

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

### `POST /api/subscriptions/{id}/activate`
SM-004. Starts a `DRAFT` subscription (`POST /api/subscriptions` with
`"draft": true` saves one without starting it).

### `POST /api/subscriptions/{id}/renew`
`{ "endDate": "2026-12-31" | null }` — renews a `RENEWAL_PENDING` subscription.
Omitting `endDate` extends the subscription by the same term length; `null`
removes the end date. For a payment-due renewal it succeeds once the wallet
covers the next deliveries.

### `GET /api/subscriptions/{id}/deliveries?from=&days=30`
SM-004. Each delivery date with its own status: `SCHEDULED`, `SKIPPED`, or the
order's status once the order exists.

### `POST /api/subscriptions/{id}/retry`
`{ "date": "2026-08-20" }` — retries a day that failed for insufficient balance.

A past or already-processed date cannot be modified.

---

## Notifications

### `GET /api/notifications?unreadOnly=true`
### `PATCH /api/notifications` — `{ "id": "uuid" }` or `{ "all": true }`

---

## Seller verification

PAN, GSTIN, Udyam, FSSAI and Shop Act checks through the KYC vendor (see
`docs/seller-verification/README.md`). Numbers are returned masked only.

### `GET /api/shops/{id}/verifications`
Owner or reviewer. All five documents with status, masked number, name on
record, expiry, requirement (`required`, `required_or_declaration`,
`optional`), uploaded files, the consistency score and `missing`.

### `POST /api/shops/{id}/verifications`
`{ "docType": "PAN|GSTIN|UDYAM|FSSAI|SHOP_ACT", "number": "...", "consent": true }`.
Format-checked first (422 on a typo, no vendor call). Returns the document's
new state. 429 after 10 seller-triggered paid checks per shop per hour.

### `POST /api/shops/{id}/verifications/gst-declaration`
`{ "declaration": true, "enrolmentNumber": "optional" }` — the shop is not
GST-registered; goes to admin review.

### `POST /api/shops/{id}/verifications/shop-act-certificate`
Multipart: `file` (PDF/JPEG/PNG/WebP, ≤ 5 MB, checked from the bytes),
`number`, `consent=true`. Stored encrypted.

### `GET /api/seller-verifications/files/{fileId}`
The uploaded certificate — its shop's owner or a reviewer only. Reviewer
views are audited.

### `GET /api/admin/seller-verifications`
Reviewer. Documents waiting for a decision, oldest first.

### `POST /api/admin/seller-verifications/{id}/decision`
`{ "decision": "approve|reject", "reason": "..." }` — a reason is required to
reject and is shown to the seller.

### `POST /api/admin/seller-verifications/{id}/recheck`
Ask the vendor again with the number on file.

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

### `POST /api/cron/seller-verification`
Daily seller verification sweep: retries, GSTIN re-check, expiry warnings,
expiry, suspension when a mandatory document lapses. Bearer `CRON_SECRET`.
Returns `{ pendingRetried, gstRechecked, expiryWarnings, expired, shopsSuspended, errors }`.

### `POST /api/cron/shop-acceptance`
NEW-007, every minute. Reminds shops about orders waiting for acceptance and
cancels, with a full refund, orders not accepted by their accept-by time.
Bearer `CRON_SECRET`. Returns `{ reminded, cancelled, skipped }`. Does nothing
while rule `shopAcceptance` is off.

## Rate limits

| Scope | Limit |
|---|---|
| Payment create/verify | 10 / minute / user |
| Checkout | 15 / minute / user |
| Cron | 30 / minute / IP |

Exceeding a limit returns `429` with `details.retryAfterSeconds`.
