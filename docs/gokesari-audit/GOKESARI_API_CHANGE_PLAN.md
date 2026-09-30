# GoKesari — API Change Plan

*No API route has been added or changed by this audit. This plan covers (§1) fixes to existing endpoints' behaviour, (§2) new endpoints for service logic that already exists and is already tested but unreachable, and (§3) the new endpoint families later phases will need, named but not yet designed pending the decisions in the roadmap. Existing endpoints not listed here are unaffected and stay exactly as documented in [API.md](../../API.md).*

All existing and new routes follow the project's own established pattern (`server/api/handler.ts`): **parse (Zod) → authorize (`requirePermission`/`requireShopAccess`) → call one service function → respond**, with the single error shape already documented in `API.md`. Nothing below deviates from that.

## 1. Behaviour fixes to existing endpoints (no URL/method change, no new request/response fields)

| Endpoint | Change | Backward compatible? |
|---|---|---|
| `PATCH /api/orders/[id]/status`, own-order branch | **Enforce `ORDER_CANCEL_OWN` and gate the customer's own cancel by status, per decision D10 (resolved 2026-09-22 — finding DEF-08)** — today this branch accepts `CANCELLED` from *any* pre-terminal status including `OUT_FOR_DELIVERY`, with no capability check at all. New behaviour: `CONFIRMED` → allowed, full refund; `PREPARING`/`READY` → rejected (`CONFLICT`, "please contact the shop"); `OUT_FOR_DELIVERY` → allowed, goods-only refund | **No — a deliberate, decided behaviour change**, not a compatibility-preserving fix. It narrows what a customer can do at `PREPARING`/`READY` today, and changes the refund amount at `OUT_FOR_DELIVERY`. Needs its own route-level tests proving all three branches (full refund, blocked, goods-only) |
| `cancelOrder` (called by the same endpoint) | Compute the refund from D10's table instead of always refunding `totalPaise`; cancel or re-route any active `delivery_orders` row in the same transaction (part of the DEF-08 fix — this is also what closes DEF-04's reachable "rider delivers, `markDelivered` throws, goes unpaid" path); still credit the rider's delivery earnings when the cancel happens at `OUT_FOR_DELIVERY`, per D10 | Same caveat as above — bundled into the DEF-08+DEF-01 change, not a separate silent fix. Shop/operator-initiated cancellation is **unaffected** — it keeps today's full-refund behaviour at every status |
| `PATCH /api/orders/[id]/status`, privileged branch | Stop accepting `CONFIRMED` as a target status for this branch (finding DEF-06) — it becomes reachable only through checkout and the subscription retry path, both of which already gate it on an actual payment | Yes for every legitimate caller today — no current test or documented flow relies on setting `CONFIRMED` through this route. **Re-check after D8 lands** (Opus review §6.4): if D8 extends `order_status` with `SHOP_PENDING`/`ACCEPTED`/`REJECTED`, this endpoint's allowed-target list gets rewritten again in Phase 4, so treat this as the *current* shape, not the final one |
| `cancelOrder` (same function as the DEF-08 row above) | Restock consumed inventory on cancel (finding DEF-01) — **not a one-line change**: `restockOnline` needs an optional `client?: DbClient` parameter added first (it currently opens its own transaction, unlike its mirror `consumeOnlineStock`), then a call with `tx`. Ship in the **same commit** as the DEF-08 fix, not a separate one, since both touch `cancelOrder`'s body | Yes — response shape unchanged, only a side effect (stock count) is corrected |
| `checkout`, `updateOrderStatus`, `assignNearestPartner`, `inventory-alerts` evaluation | Emit the already-defined notification types instead of nothing (finding DEF-02) | Yes — additive, no response shape change |
| `acceptDeliveryOffer` / `rejectDeliveryOffer` | Guard the UPDATE on the expected current status instead of a separate unguarded check (finding DEF-04) | Yes — a legitimate single accept/reject behaves identically; only the race window closes |
| `assignNearestPartner` | Wrap in one transaction with a lock so two orders cannot offer the same partner at once (finding DEF-03, **narrowed** — the "re-offer excluding prior rejecters" behaviour is a separate, later change, see §3's delivery-assignment-config entry and decision D11) | Yes — same request/response; only concurrent-safety changes |
| `requireShopAccess` (used by 16 routes, not a route itself) | Add an owner-side capability parameter so role demotion revokes access, and check `shops.status` (finding SEC-06, decision **D12**) | **No — a deliberate, decided behaviour change** for existing shop owners, same caveat as the DEF-08 row. Every route using this guard needs its own negative-RBAC test proving a demoted/suspended owner is now blocked |

## 2. New endpoints for already-built, already-tested service logic

These services exist, are exercised by integration tests, and have real permissions already defined in the capability matrix — they only need a thin route and, where relevant, a form. Each follows the existing pattern exactly.

### `PATCH /api/shop-products/[id]/thresholds`
- **Auth:** `requirePermission(INVENTORY_THRESHOLD_MANAGE_OWN)` + `requireShopAccess` (owner of the shop, or operator/admin).
- **Request:** `{ lowStockThreshold?, reorderLevel?, reorderQuantity?, minimumOrderQuantity?, maximumOrderQuantity? }` (all optional, all the existing `shop_products` columns from migration `0014`).
- **Response:** the updated shop-product row.
- **Validation:** Zod, mirroring the existing DB `CHECK` constraints (non-negative, `max >= min`).
- **Calls:** `setStockThresholds` (`inventory-alerts.ts:151`, already implemented, already tested, zero current callers).
- **Idempotency:** natural — a PATCH with the same body is a no-op.
- **Audit:** add a threshold-changed action (new `AUDIT_ACTIONS` entry; the audit table and `recordAudit` helper are unchanged).

### `GET /api/shops/[id]/stock-alerts`
- **Auth:** `requireShopAccess` (owner, or `DELIVERY_PARTNER_MANAGE`-equivalent operator scope — reuse `SHOP_PRODUCT_MANAGE_ANY`/`OWN` since alerts are a shop-product concept).
- **Response:** open/acknowledged alerts for the shop, from `listStockAlerts` (`inventory-alerts.ts:231`, already implemented, zero current callers).
- **Idempotency:** n/a (read-only).

### `PATCH /api/products/[id]/identity`
- **Auth:** `requirePermission(PRODUCT_IDENTITY_MANAGE)` (operator/admin; already in the matrix, currently unused).
- **Request:** subset of `{ gtin, hsnCode, gstRateBp, manufacturerName, manufacturerAddress, countryOfOrigin, netQuantity, netQuantityUnit }`.
- **Calls:** `updateProductIdentity` (`product-master.ts:259`, tested, zero current callers).
- **Validation:** GTIN format/checksum (reuse `normalizeGtin`), GST rate 0–10000 bp (already a DB `CHECK`).
- **Backward compatible:** yes — new route, no change to `POST /api/products`.

### `POST /api/products/[id]/mrp`, `POST /api/products/[id]/mrp/dispute`, `GET /api/products/[id]/mrp/history`
- **Auth:** `PRODUCT_MRP_MANAGE` (operator/admin, set) vs. `PRODUCT_MRP_DISPUTE` (shop owner, flag only — never overwrites).
- **Calls:** `setMasterMrp`, `submitMrpCorrection`, `getMrpHistory` (`product-master.ts:129,195,231` — all implemented and tested, zero current callers).
- **Idempotency:** `setMasterMrp` should key on `(productId, effectiveFrom)` if repeated; check the service's existing behaviour before wiring the route (it currently has no caller to reveal an implicit contract, so this needs a route-level test written alongside it).

### `POST /api/brands`, `PATCH /api/brands/[id]`, `POST /api/categories`
- **Auth:** `BRAND_MANAGE` / `CATEGORY_MANAGE` (operator/admin).
- **Calls:** `createBrand`, `updateBrand` (`brands.ts:42,77`), `createCategory` (`catalogue.ts:56`) — all implemented and tested, zero current callers (brands/categories today arrive only via Product Master promotion or the seed script).

### `POST /api/shops/[id]/suspend`, `POST /api/shops/[id]/reactivate`
- **Auth:** `SHOP_SUSPEND` (operator/admin).
- **Calls:** `setShopStatus` (`shops.ts:430`, implemented, zero current callers).
- **Audit:** already covered by the existing shop-status audit action pattern.

### `GET /api/orders/[id]`, `GET /api/orders` (admin scope), admin order list/detail page
- **Auth:** owner of the order (customer), or `requireShopAccess`(shop), or `ORDER_VIEW_ANY` (operator/admin — defined, currently unused).
- **Calls:** `getOrder` (`orders.ts:458`, implemented, zero current callers) for detail; a new `searchOrdersAdmin` analogous to `shops.ts`'s existing `searchShopsAdmin` pattern for the list.
- **Why now:** this is the single biggest "built but unreachable" gap in Orders — support/operations currently cannot look up an order at all outside the database.

## 3. New endpoint families for later phases (named, not yet specified)

These depend on decisions or subsystems that don't exist yet (roadmap decisions D1, D5, D6, D8). Specifying exact request/response shapes now would be premature — each gets its own API design pass at the start of its implementation phase, following this same parse→authorize→service→respond pattern and the same error-shape contract.

- **Shop accept/reject** (`POST /api/orders/[id]/accept`, `/reject`) — needs decision D8 (order-state extension) settled first.
- **Society** (`POST /api/societies`, `/api/societies/[id]/verify`, `/api/societies/[id]/workers`, `/api/societies/[id]/workers/[partnerId]/authorize|revoke`) — needs decision D5 (society model) settled first; will follow the shop-registration/approval route shapes closely.
- **Direct order payment** (`POST /api/checkout` gains a payment-method branch, or a new `/api/orders/[id]/pay`) — needs decision D1; must reuse the existing Cashfree webhook/idempotency machinery, not a parallel one.
- **Settlement/payout** (`GET /api/admin/settlements`, `POST /api/admin/payouts`) — needs decision D6 (commercial model) settled first.
- **Assignment scoring configuration** (`GET/PATCH /api/admin/delivery-assignment-config`) — modelled directly on the existing `GET/PATCH` pattern for `delivery_earnings_config`; needs the DEF-03/DEF-04 lifecycle fixes landed first so the engine isn't built on top of a race.
- **Marketing campaigns** (`POST /api/campaigns`, consent/suppression endpoints) — needs decision D9 (marketing scope + legal review) settled first.

## 4. What every new/changed route must satisfy (unchanged project standard)

Per `API.md` and the existing route handler pattern, already enforced by `server/api/handler.ts` and demonstrated by all 95 existing routes:

- Authentication via the session cookie; authorization via `requirePermission`/`requireShopAccess`/`requireSubscriptionAccess` — **never** a client-supplied role or ownership claim.
- Every external input parsed with Zod at the boundary.
- The single error shape (`{ error: { code, message, details } }`) and existing error codes; a genuinely new failure mode gets a new code documented in `API.md`, not an ad hoc message.
- Money in integer paise, quantities in integer milli-units — no exception.
- A mutating route that can plausibly be retried (double-tap, client retry, webhook redelivery) needs an idempotency key, following the existing `checkout`/`payments`/`daily-orders` pattern.
- A sensitive mutation (approval, classification, price, wallet, refund, role, order status, delivery assignment, GST/PAN, MRP, society-worker authorization) calls `recordAudit` in the same transaction as the write.
- Rate-limit anything unauthenticated, and anything authenticated that could be abused to guess a secret (voucher codes, grievance tickets) — see finding SEC-04.
