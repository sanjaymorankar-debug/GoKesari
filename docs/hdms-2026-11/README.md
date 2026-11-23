# GoKesari Hyperlocal Delivery Management System (HDMS)

Owner brief: 23-Nov-2026 ("Master development prompt — HDMS"). Branch `feat/hdms-delivery-2026-11-23`, cut
from `origin/staging` at `616c59d0`. Migration `0190_hdms_delivery` (rollback `scripts/rollback-0190.sql`).
Flag **`hdms_enabled`** (OFF while its row is missing — production and staging stay exactly as today until
it is switched on in Admin → Settings → Feature flags).

Contents: §1 gap analysis · §2 change impact · §3 architecture · §4 database · §5 API · §6 providers ·
§7 pricing · §8 deployment · §9 tests (TEST_REPORT.md) · §10 defects (TEST_REPORT.md) · §11 open items.

---

## 1. Existing code gap analysis

GoKesari already had most of a delivery system. HDMS extends it; it does not replace any of it.

| Brief item | Already in GoKesari (reused) | Gap closed by HDMS |
|---|---|---|
| Gokesari gig riders: registration, KYC, licence, vehicle, bank, approval, availability, zone, assignment, tracking, earnings, settlements, ratings, complaints | `delivery_partners`, rider KYC (DigiLocker / PAN), documents, background docs, availability gate, rider zoning, `delivery_orders` dispatch with offers / broadcast / trips, delivery OTP, proof photos, earnings + incentives, rider wallet and bank payouts with TDS, ratings, grievances, disputes | none — linked from Admin → Delivery → GoKesari delivery partners |
| Shop-owned riders | `shop_delivery_staff` (name, mobile, active), own-delivery fulfilment with private rider link `/delivery/[token]`, customer code at the door | availability (on/off duty), vehicle, ID proof (last 4 only) + admin verify; used by the allocation engine |
| External providers (Shadowfax, Pidge, Porter, Borzo) | none | common gateway + adapters, credentials (encrypted), webhooks, polling, API logs, circuit breaker |
| Serviceability | shop radius + pincodes (`serviceability.ts`) | delivery zones (circle / polygon, suspend, max km), partner serviceability quotes |
| Pricing | shop flat fee + free-above (customer); shop wallet per-km charge for GoKesari-rider deliveries; rider pay rules | pricing rules (min, per km, per kg, express, peak IST windows, cap, promo) and 5 commercial models; shop share charged through the existing shop wallet |
| Allocation | nearest-rider dispatch, retries, broadcast, batching | engine across shop rider → GoKesari rider → partners, quotes ranked by fee + ETA + reliability, product needs, idempotent booking |
| Tracking | customer tracking page, rider GPS, road ETA | partner status, ETA, masked rider number and position in the same tracking card |
| Cancellation / failure / return | order cancel + refunds, rider failed drop, returns | partner cancel (customer / shop / partner / admin), failed after pickup → FAILED, return → RETURNED, re-allocation when a partner drops before pickup |
| Settlement | rider payouts, shop wallet, finance ledger | partner settlements + invoice reconciliation |
| Admin | rider screens, slots, rider pay | Admin → Delivery management (17 sections below) |
| Scheduled dairy | subscriptions, subscription deliveries, scheduled slots | guard: subscription / scheduled orders never go to instant allocation |
| Product attributes | `is_perishable` on subcategories | `product_delivery_attributes` (perishable, fragile, temperature, refrigeration, max minutes, weight, size, packaging) |

## 2. Change impact matrix

| Existing component | Existing functionality | Change | Class | Reason |
|---|---|---|---|---|
| `services/delivery-assignment.ts` `dispatchReadyOrder` | GoKesari rider search | +2 hooks: skip while a partner carries the order; book a partner after N failed attempts / when the search stops (flag) | EXTEND | partner fallback |
| `services/orders.ts` `cancelOrder` | cancel + refund | after commit: cancel the partner booking (never throws) | EXTEND | customer / shop cancellation |
| `services/finance.ts` `walletCollectionFor` | shop wallet delivery charge for rider deliveries | partner delivery → shop's share from the booking's pricing split | EXTEND | shop-pays / shared models |
| `services/fulfilment-options.ts` `toStaffView` | shop staff view | +5 read-only fields | EXTEND | availability, vehicle, ID |
| `cron/schedule.ts` `timeoutSweep` | every-minute sweeps | +1 step: poll partner bookings (flag) | EXTEND | tracking without webhooks |
| `api/tracking/[orderId]` | customer tracking | + `partner` field (null for every other order) | EXTEND | partner tracking |
| `components/live-tracking-map.tsx` | tracking card | renders partner block when present | EXTEND | customer view |
| `components/delivery-staff-manager.tsx` | shop staff list | on/off duty, vehicle & ID form | EXTEND | shop riders |
| `lib/board/menus.ts` | boards | Admin "Delivery management" hub; Operator riders hub link; Shop "Partner deliveries" | EXTEND | navigation |
| `config/rules.ts` | business rules | + `deliveryAllocation` | EXTEND | configurable engine |
| `feature-flags` (schema, labels, panel) | flags | + `hdms_enabled` | EXTEND | safe release |
| `db/schema.ts` | schema | re-export `hdms-schema.ts`; 6 columns on `shop_delivery_staff` | EXTEND | — |
| Order management, checkout, payments, wallet, accounting ledger, auth, RBAC, rider app, OTP, proofs, earnings, payouts, subscriptions | — | none | NO CHANGE | out of scope |

No file was deleted, no table or column renamed or dropped.

## 3. Architecture

```
READY order ──► dispatchReadyOrder (existing) ──► GoKesari rider offered? ── yes ─► existing flow
                    │ no rider after N attempts / search stopped (flag hdms_enabled)
                    ▼
            allocation.ts  allocateOrder()
              1 coordinates, distance, zone (zones.ts)   2 product needs (requirements)
              3 channels in rule order: SHOP_RIDER → GOKESARI_RIDER → EXTERNAL
              4 quote enabled partners in parallel (registry.callProvider: timeout, retry, circuit, rate limit, API log)
              5 filter (serviceable, refrigeration, weight, distance, reliability, max minutes) + rank (fee/ETA/reliability)
              6 book best (idempotency key; order row lock + one-live-booking unique index), next on failure
                    ▼
            delivery_bookings ◄── webhooks.ts (signed, one event id once) ◄── partner
                    ▲          ◄── bookings.pollActiveBookings (cron)        
                    │ applyBookingUpdate: booking state machine → order status via updateOrderStatus (existing:
                    │ COD, finance snapshot, shop wallet, invoice, notifications) · failed/cancelled before pickup → re-allocate
                    ▼
            settlements.ts (period totals, invoice reconciliation) · tracking.ts (customer card) · admin.ts (read models)
```

Components of the brief → modules: Integration Gateway `delivery/providers/registry.ts` · Provider Master
`delivery_providers` · Serviceability `zones.ts` + adapter `quote` · Pricing `pricing.ts` · Allocation
`allocation.ts` · Shop riders `shop_delivery_staff` + `admin.updateShopRiderProfile` · GoKesari riders (existing) ·
Booking `bookings.ts` · Tracking `bookings.ts` + `tracking.ts` · Webhooks `webhooks.ts` · Cancellation / return
`bookings.ts` · Settlement `settlements.ts` · Analytics `admin.deliveryDashboard / integrationHealth` · Admin
`app/admin/delivery/*`. No provider-specific code exists outside `delivery/providers/`.

Order effects of a partner booking: ASSIGNED/AT_PICKUP → order ASSIGNED; PICKED_UP → PICKED_UP; IN_TRANSIT →
OUT_FOR_DELIVERY; DELIVERED → DELIVERED; failed or cancelled before pickup → order back to READY and the next
partner is tried (the same partner is not retried); failed after pickup → FAILED; RETURNED → RETURNED. Partner
updates are recorded as the shop's (the shop handed the parcel over) with the partner and reference in the note.

## 4. Database (migration 0190, additive, re-runnable)

New tables: `delivery_providers` (seeded: SHADOWFAX, PIDGE, PORTER, BORZO — off, not integrated; MOCK —
sandbox simulator, off), `delivery_zones` (seeded: Baner, Aundh, Balewadi, Wakad, Hinjawadi, Kharadi, Viman
Nagar, Kothrud, Deccan, Hadapsar — approximate centres, 3 km circles, 6 km max; edit in Admin), 
`delivery_pricing_rules` (seeded: "Pune default", free above ₹499), `delivery_bookings` (partial unique index:
one live booking per order; unique provider + reference; unique idempotency key), `delivery_events`,
`delivery_allocation_runs`, `delivery_quotes`, `delivery_webhook_logs` (unique provider + event id),
`delivery_api_logs`, `delivery_settlements` (unique provider + period), `delivery_reconciliation_lines`,
`product_delivery_attributes`. Columns added to `shop_delivery_staff`: `is_available`, `vehicle_type`,
`id_document_type`, `id_document_last4`, `id_document_image_id`, `kyc_status`.

Not created (already covered): rider tables, rider documents, availability, assignments (`delivery_orders`),
configuration (`platform_settings` rule `deliveryAllocation`).

Journal `when` = 1793270000000, above every in-flight branch (dealer platform 0176–0181 end at 1793269100000).
**If another branch with a lower `when` merges after this one, its migrations would be skipped by drizzle — the
later of the two must take a higher `when`.**

## 5. API

| Route | Who | Purpose |
|---|---|---|
| `PATCH /api/admin/delivery/providers/[code]` | Super Admin | enable (integrated only), environment, priority, base URL (https), timeout, reliability, limits, credentials / webhook secret (write-only, encrypted), reset circuit |
| `GET,POST /api/admin/delivery/zones` · `PUT,POST /api/admin/delivery/zones/[id]` | Ops read / suspend-resume; Super Admin create-edit | zones |
| `GET,POST /api/admin/delivery/pricing` · `PUT …/pricing/[id]` | Ops read; Super Admin write | pricing rules |
| `GET,POST /api/admin/delivery/bookings/[id]` | Ops | detail; `cancel`, `refresh`, `simulate` (sandbox only, never on gokesari.com) |
| `POST /api/admin/delivery/orders/[orderId]/allocate` | Ops | run the engine now |
| `GET,POST /api/admin/delivery/settlements` · `GET,POST …/settlements/[id]` | Finance read; Super Admin write | settlements; `reconcile` (CSV), `paid` |
| `POST /api/admin/delivery/shop-riders/[id]` | Super Admin | verify / reject a shop rider's ID proof |
| `PUT /api/admin/delivery/product-attributes/[productId]` | PRODUCT_MANAGE | product delivery attributes |
| `PATCH /api/shops/[id]/delivery-staff/[staffId]/profile` | shop owner (own shop) | on duty, vehicle, ID proof (last 4 kept) |
| `POST /api/shops/[id]/orders/[orderId]/delivery-partner` | shop owner (own order) | find delivery now |
| `POST /api/delivery/quote` | signed-in user (own address) | pricing-rule split for a trip (informational) |
| `GET /api/tracking/[orderId]` | existing access rules | + `partner` block |
| `POST /api/webhooks/delivery/[provider]` | partner (signature) | status events |

Errors follow the existing handler: 401 unsigned / not signed in, 403 role, 404 not found or another shop's,
409 conflict (duplicate, not cancellable, not integrated), 422 validation, 429 rate limit, 500 → partner retries.

## 6. Providers

Shadowfax, Pidge, Porter and Borzo do not publish their on-demand APIs (searched 23-Nov-2026: only marketing
pages and third-party integration notes, no endpoint, payload or webhook specification). Per the brief ("do
not invent API endpoints or credentials") their adapters are registered but **not integrated**: every call
refuses with `NOT_INTEGRATED`, Admin cannot enable them, and their webhooks answer 401. To integrate one:
obtain the API document, sandbox base URL, keys and webhook signature scheme; replace its `pending(...)` entry
in `delivery/providers/partners.ts` with real `quote / book / track / cancel / verifyWebhook / parseWebhook`
calls; set `capabilities.integrated = true`; enter the keys in Admin → Delivery providers (SANDBOX on staging,
PRODUCTION on gokesari.com); test on staging with the partner's sandbox.

`MOCK` (sandbox simulator) implements the whole contract in-process for staging and tests. It is refused on
gokesari.com (and PRODUCTION-environment partners are refused off it), so staging never makes a live booking.

## 7. Pricing

Rules split a delivery's cost between customer, shop and GoKesari (five models). The shop's share is charged
through the existing shop wallet when the order is delivered (rule `shopWallet` on). **The customer's checkout
fee is unchanged** (the shop's flat fee / free-above): the cart has no delivery address, so a distance-based fee
computed only at checkout would differ from the fee the customer saw. Wiring rule fees into the cart and checkout
is listed in §11.

## 8. Deployment

Staging: PR into `staging` labelled `ready-for-staging`; the staging queue runs CI, migration 0190, deploy,
post-deploy check and guest QA. After it is verified, on staging: Admin → Delivery providers → Sandbox simulator
→ set a webhook secret, enable; switch `hdms_enabled` on; walk a ready order through (no rider online → partner
booked → Simulate events). Production: only in the 23.00 IST release window, one release at a time
(DEPLOYMENT.md §3), with `hdms_enabled` left **off** — production has no integrated partner to book, so the
switch stays off until a real partner is integrated and approved. Rollback: switch the flag off (instant);
code rollback through the normal redeploy; schema rollback `scripts/rollback-0190.sql` only after exporting
partner bookings (it drops only HDMS tables and the 6 added columns).

## 11. Open items (owner / external)

1. Shadowfax, Pidge, Porter, Borzo: API documents, sandbox access, keys, commercial agreements (none available).
2. Checkout fee from pricing rules (needs the delivery address in the cart; product decision).
3. Exact zone boundaries for the 10 Pune areas (seeded centres are approximate; edit in Admin → Delivery zones).
4. Masked calling (needs a telephony provider; the rider's number is shown masked meanwhile).
5. Shop-rider ID proof image upload (the column exists; the shop form takes the number only today).
