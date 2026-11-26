# Flow spec v3 — wave 2

F2 customer order, F20 multi-shop cart, F3 order fulfilment, F19 order timeouts, F16 cancellations / refunds /
returns, F13 product and inventory setup. Owner decisions of 27-Nov-2026.

Everything new is behind a feature flag. With a flag off the site behaves exactly as before: the older rules
(`shopAcceptance`, `dispatch`, `dispatchBroadcast`, `cancellation`, `afterPackingCancellation`, `returns`, the
Admin → Finance commission table) keep their stored values and defaults; wave 2 never changes them. Its values
live in a new rule group, `orderFlowsV3`, read only while the matching flag is on.

## Flags (migration 0221)

Seeded **ON** on the staging database (`gokesari_test`) and **OFF** everywhere else
(`enabled = current_database() = 'gokesari_test'`, `ON CONFLICT DO NOTHING`).

| Flag | What it switches on |
|---|---|
| `flow_f2` | No referral code before the first order (the MANDATORY setting no longer blocks checkout); an optional code box on the first order's page after payment; checkout asks Online / cash on delivery explicitly (nothing preselected; `/api/checkout` refuses a personal order without a method). |
| `flow_f20` | When one shop of a multi-shop checkout declines or cancels its part, the customer is told and may cancel the other parts still cancellable (full refund each). |
| `flow_f3` | "Packed & ready" straight from Accepted (picking starts on the way); commission 2% where Admin → Finance has no rate. |
| `flow_f19` | Accept within 10 min (reminder at half time in the app and on the shop's WhatsApp where `whatsapp_shop_orders_enabled` is on); silent shop → cancel + full refund + a nearby shop with the same items suggested; rider search widens every 5 min, stops after 20; no rider and no switch to own delivery / pickup → cancel + full refund; pickup not collected 60 min after its slot → the shop may cancel. |
| `flow_f16` | Customer cancels until packing (full refund incl. delivery fee); after packing the customer asks the shop, which agrees (full refund, no charge) or declines; returns: 2-day window, photo only for damaged / wrong item, food and medicine categories not returnable except for defects; a declined return can be taken to a dispute; the shop is told when a return is refunded; a failed delivery is refunded automatically. |
| `flow_f13` | Choosing a category lists every master product in it at stock 100; master-list picks start at stock 100; an exact name match asks "use existing / add new"; any shop type can create its own product type (sent for review); a "ready for product upload" e-mail when a shop goes live by any approval path. |

## Rule `orderFlowsV3` (Admin → Business rules)

| Field | Value | Source |
|---|---|---|
| `shopAcceptMinutes` | 10 | owner |
| `acceptReminderAtFraction` | 0.5 | owner |
| `suggestAnotherShop` | true | owner ("optionally") |
| `suggestRadiusKm` | 5 | DEFAULT – confirm with Sanjay |
| `riderWidenAfterMinutes` | 5 | owner |
| `riderGiveUpMinutes` | 20 | owner |
| `noRiderCancelAfterMinutes` | 10 (0 = never) | DEFAULT – confirm with Sanjay |
| `pickupGraceMinutes` | 60 | owner |
| `returnWindowHours` | 48 | owner (2 days) |
| `returnPhotoReasons` | DAMAGED, WRONG_ITEM | owner |
| `nonReturnableDepartments` | FRUIT_VEGETABLE, DAIRY, BAKERY, MEAT_SHOP, SWEET_SHOP, RESTAURANT, FAST_FOOD, CAFE, PHARMACY | owner (food + medicines); the exact list is a DEFAULT – confirm with Sanjay (kirana / supermarket left out as mixed goods) |
| `nonReturnableCategorySlugs` | (empty) | admin-editable, by category slug |
| `nonReturnableExceptReasons` | DAMAGED, WRONG_ITEM, EXPIRED | DEFAULT – confirm with Sanjay |
| `failedDeliveryRefundAfterMinutes` | 30 | DEFAULT – confirm with Sanjay |
| `defaultCommissionBps` | 200 (2%) | owner (seller agreements) |
| `defaultListingStock` | 100 | owner policy |

The after-packing cancellation charge is ₹0 and needs the shop's agreement (owner); there is no charge field.

How the older rules read while a flag is on (`src/server/flows/wave2-rules.ts`):

- `flow_f19`: `shopAcceptance` → enabled, 10 min, reminder 0.5, cancel on timeout; `dispatch.maxSearchMinutes` → 20;
  `dispatchBroadcast` → enabled, step 300 s.
- `flow_f16`: `cancellation.customerMayCancelUntil` → PREPARING; `afterPackingCancellation.enabled` → off (a packed
  order goes through the shop's agreement); `returns` → window 48 h, photo only for the listed reasons.

Unchanged on purpose: the shop's own delivery fee (shown per shop before payment, as today — no GPS estimate, no base
fee); the settlement hold (3 days on production).

## Migration 0221 (`drizzle/0221_flows_v3_wave2.sql`)

Additive only: new table `order_cancel_requests` (one PENDING request per order, partial unique index), nullable
column `order_disputes.return_request_id` with a partial index, and the six flag rows. Nothing is dropped, renamed or
deleted. If wave 1 (0221) is merged first, this file is renumbered to 0222 by the staging queue.

## Where it lives

- `src/server/flows/` — `wave2-rules.ts` (flag-aware rule reads), `f19-timeouts.ts`, `f16-cancellations.ts`,
  `f20-multishop.ts`, `f2-order.ts`, `f13-products.ts`, `sweep.ts` (wave-2 steps of the every-minute timeout sweep).
- Routes: `POST/DELETE /api/orders/[id]/cancel-request`, `POST /api/orders/[id]/cancel-request/decision`,
  `POST /api/orders/[id]/pickup-not-collected`, `POST /api/orders/[id]/cancel-group-rest`,
  `POST /api/returns/[id]/dispute`, `POST /api/shops/[id]/product-types`. Each answers 404 while its flag is off.
- Screens: the customer's order page (ask the shop to cancel, cancel the rest, referral code after the first order),
  the return page (open a dispute), the shop's Orders page (cancel requests, uncollected pickups, "Packed & ready"
  from Accepted), the product set-up page (own product type), the cart (explicit payment), the add-product form
  (use existing / add new).
- Payment refunds, notifications, WhatsApp and e-mail go out after the order's transaction commits (the existing
  cancel / refund paths and outboxes). Existing APIs only gained optional fields.

## Tests

`tests/integration/flows-v3-wave2.test.ts` — 30 tests, each item with its flag on and off. The existing order,
checkout, cancellation, refund, return, dispute, acceptance, dispatch, fulfilment, pickup, product set-up, settlement,
cart and guest-cart suites and `tests/unit/migration-journal.test.ts` were run on a local database.

## Not built in this wave

- Delivery fee estimate by distance / base fee — the owner keeps the shop's own fee.
- Strict verified-mobile checkout without onboarding v2 — depends on live SMS and the dual-auth flag.
- Turning `guest_cart_enabled` / `onboarding_v2` on in production — owner decision.
- Live map for the shop's own delivery person — needs location pings from the private delivery link; larger change.
- A seeded `commission_rates` row — the 2% is applied as a fallback under `flow_f3` instead.
- Settlement hold tied to the return window — owner: keep the current 3 days.
- Managed inventory + billing plan (annual charge) — open owner question.
- Alternative-shop suggestion after a shop *rejects* (it is sent after a timeout only).
