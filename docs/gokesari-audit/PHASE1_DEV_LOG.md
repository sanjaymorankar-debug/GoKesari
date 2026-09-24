# Gokesari — Phase 1 development log

Roadmap: `D:\Projects\Gokesari\GoKesari\GOKESARI_IMPLEMENTATION_PRIORITY_UPDATED.xlsx`
(FAST_GO_LIVE_PRIORITY + MVP_VERTICAL_FLOW). Branch: `wave1/access-security`
(stacked on the uncommitted Phase 1a/1b work). Nothing committed, pushed or deployed.

Rule for this phase: development only — no tests are run here. Testing is a
separate QA phase (see "Testing handoff" in each entry).

---

## Wave 1 — access & security foundation (2026-09-24)

| ID | Previous | New | Change |
|---|---|---|---|
| RBAC-002 | IN PROGRESS | COMPLETED (decision) | Personal orders kept for every role; B2B is a separate flow: `orders.order_type` PERSONAL/B2B + `buyer_shop_id`, permission `ORDER_PLACE_B2B` (shop owner, admin) |
| GS-002 | IN PROGRESS | IN PROGRESS | `SOCIETY_ADMIN` role skeleton (customer permissions only; society powers in Wave 8) |
| GS-001 | IN PROGRESS | IN PROGRESS | Email magic-link sign-in (`src/server/auth-email.ts`); mobile OTP waits on D2 |
| GS-070 | IN PROGRESS | COMPLETED | Marketing consent grant/withdraw with history (`user_consents.granted`), profile toggle, `GET/PUT /api/consents/marketing` |
| GS-067 | IN PROGRESS | COMPLETED | `audit_logs` append-only — DB trigger refuses UPDATE/DELETE |

Migrations: `0017_wave1_access_foundation.sql`, `0018_audit_logs_append_only.sql`.
Env: `AUTH_EMAIL_FROM`, `AUTH_EMAIL_SERVER` (see `D:\Projects\Authentications\gokesari.env.template`).
Dependency: `nodemailer@^10` (v7/8 have high-severity advisories).

---

## Vertical Slice 1 — Customer → location → shop/product discovery → cart (2026-09-24)

### Status changes

| ID | Previous | New | Change |
|---|---|---|---|
| GS-010 | YET TO START | COMPLETED | Shop delivery zone: `shops.service_radius_km` (1–50, default 5); editable in the shop's Location card; `PATCH /api/shops/{id}` accepts `serviceRadiusKm` |
| GS-004 | IN PROGRESS | COMPLETED | Customer "Deliver to" location: saved address, device position, or PIN code; httpOnly cookie via `POST/DELETE /api/location`; signed-in customers default to their default address |
| GS-019 | IN PROGRESS | COMPLETED | `/shops` and search list only shops that deliver to the chosen location, nearest first, with distance; `?all=1` shows every shop |
| GS-020 | IN PROGRESS | COMPLETED | Product search limited to serviceable shops, nearest first, distance on each card |
| GS-021 | IN PROGRESS | COMPLETED | `/products/{id}` — every shop selling the same catalogue product |
| GS-022 | YET TO START | COMPLETED | Price comparison on `/products/{id}`: per-unit and per-pack price, "Lowest price", delivers-to-you status; "Compare prices" link on product cards |
| NAV-001 | IN PROGRESS | IN PROGRESS | Home: location picker + "Shops that deliver to you" (comparison entry via product cards) |
| GS-026 | YET TO START | IN PROGRESS | Cart warns per shop when it does not deliver to the chosen location; hard block at checkout is Slice 2 |

### Serviceability rule (one definition: `src/server/services/serviceability.ts`)
Shop is APPROVED, not deleted, `delivery_available = true`, and either
straight-line distance ≤ `service_radius_km` (both sides have coordinates) or,
when either side lacks coordinates, the PIN codes match exactly. No Google
Distance Matrix call.

### Files

| File | Purpose |
|---|---|
| `src/server/db/schema.ts` | `shops.serviceRadiusKm` + CHECK 1–50 |
| `drizzle/0019_shop_service_radius.sql` (+ meta snapshot/journal) | Migration — **not applied anywhere yet** |
| `src/lib/location.ts` | Location shape, cookie name, parse/serialize (zod-validated) |
| `src/server/location.ts` | `getCustomerLocation()` (cookie → default address), `locationFromAddress()` |
| `src/server/services/serviceability.ts` | `shopServiceability()`, `listServiceableShops()`, `serviceableShopIds()` |
| `src/app/api/location/route.ts` | New API — set/clear delivery location |
| `src/server/services/shops.ts` | `searchShops({ ids })` filter; `updateShop` validates + audits `serviceRadiusKm` |
| `src/server/services/catalogue.ts` | `listStorefrontProducts({ shopIds, productId })` filters |
| `src/app/api/shops/[id]/route.ts` | Accepts `serviceRadiusKm` |
| `src/components/location-picker.tsx`, `location-bar.tsx` | "Deliver to" UI |
| `src/app/page.tsx` | Location bar, "Shops that deliver to you", `ProductGrid` distance + compare link |
| `src/app/search/page.tsx`, `src/app/shops/page.tsx` | Location-filtered, nearest-first results with "Show all" toggle |
| `src/app/products/[id]/page.tsx` | New comparison page |
| `src/components/product-card.tsx`, `shop-grid.tsx` | Distance display, "Compare prices" link |
| `src/components/shop-location-settings-form.tsx`, `src/app/shop/page.tsx` | Delivery-radius field for shop owners |
| `src/app/cart/page.tsx`, `src/components/cart-view.tsx` | Per-shop "does not deliver here" warning; preselect the address chosen as location |
| `API.md` | `/api/location`, `PATCH /api/shops/{id}` radius, checkout `orderType` |

### Deployment notes
- Apply migrations 0017, 0018, 0019 in order (test DB first). 0019 is additive
  (`DEFAULT 5`), so existing shops get a 5 km zone.
- Existing shops without a pinned location are matched by PIN code only.

### Testing handoff (Slice 1 — not performed here)
- Location picker: saved address, device location (allow/deny), PIN code, clear; cookie persists across pages; invalid PIN rejected
- Signed-in customer with a default address and no cookie → discovery uses that address
- Serviceability: inside/outside radius, exactly at radius, shop with delivery off, shop without coordinates (PIN match / mismatch), unapproved shop never listed
- `/shops` and `/search`: filtered + nearest first, distance shown, "Show all shops" toggle keeps other filters
- `/products/{id}`: all shops listed, sort order (deliverable+buyable → price → distance), lowest-price badge, pack price for non-1-unit packs, out-of-stock/in-shop-only rows, 404 for bad id
- Shop owner sets delivery radius (1–50 accepted, 0/51/decimal rejected), audit entry written
- Cart: warning shown only for non-serviceable shops; address preselected from location
- Regression: home page, category pages, shop page, add to cart, checkout (personal + B2B) unchanged when no location is set

---

## Vertical Slices 3–4 — shop fulfilment → substitution → state machine → rider handover (2026-09-24)

The brief for this stage arrived truncated after Part E; Operations
(Slice 5) and Settlement (Slice 6) are not started here.

### Status changes

| ID | Previous | New | Change |
|---|---|---|---|
| SM-001 | IN PROGRESS | COMPLETED | Order enum extended additively (ACCEPTED, ASSIGNED, PICKED_UP, FAILED, RETURNED, DISPUTED); transition table covers the full approved machine; every change still goes through `updateOrderStatus` → `order_status_history` + audit; paid-status classification is now compiler-checked (D8 note) |
| GS-034 | IN PROGRESS | COMPLETED | Shop accept / reject (reject = full refund + restock). Timeout escalation not built (needs Slice 5 monitoring) |
| GS-035 | YET TO START | COMPLETED | Substitution: shop proposes from its own online products → customer approves (stock taken, price difference refunded) or rejects (line removed + refunded) |
| GS-036 | IN PROGRESS | COMPLETED | Per-line picking, pack → READY; pending lines are taken as picked; blocked while a substitution awaits the customer. SLA reporting is Slice 5 |
| WF-002 | IN PROGRESS | COMPLETED | Notify → accept → stock/line check → substitute/remove → pick → pack → READY |
| GS-039 / GA-006 | IN PROGRESS | COMPLETED | Rider requested automatically when the shop marks READY; cron sweep retries |
| GA-009 | IN PROGRESS | COMPLETED | Offers expire after 2 min; declining/expired riders are never re-offered the order; shop notified once while the system keeps retrying |
| GA-005 | IN PROGRESS | IN PROGRESS | Unchanged: busy riders are excluded (no batching) |
| GS-041 | YET TO START | COMPLETED | Pickup code issued when the rider accepts; shop reads it out; rider must enter it |
| GS-043 | YET TO START | COMPLETED | Customer OTP issued when the rider starts the drop; 5 attempts; operations override with a proof note (photo POD not built) |
| WF-005 | IN PROGRESS | IN PROGRESS | Pickup code → start → OTP → delivered, plus failed delivery → returned. Navigation/society access still open |
| RBAC-007 | IN PROGRESS | IN PROGRESS | Assignment is now automatic; the shop's "Find rider now" retry remains (decision still pending) |

### Data & money rules
- Removing a line or approving a cheaper substitute refunds immediately
  (`refundOriginalDebit`, idempotent per line) and lowers `orders.subtotal/total`;
  `orders.refunded_paise` records it. A later cancellation refunds only what is
  still held (fixes a double-refund path that partial refunds would otherwise open).
- Cancellation restock skips REMOVED lines and restocks the substitute for SUBSTITUTED lines.
- A failed delivery credits the rider's earnings (the trip was made).
- The rider never receives the pickup code or the customer OTP in any page or API
  response (`toRiderView`); the shop never receives the OTP.

### Compatibility kept
- CONFIRMED → PREPARING still legal (subscription orders, old one-click flow).
- READY → OUT_FOR_DELIVERY / DELIVERED still legal for shops delivering themselves,
  but only while no rider is active on the order.
- Deliveries accepted/picked up before this release (no codes) keep the old
  one-tap pickup/deliver path.
- Existing test code calling `markPickedUp(id, actor)` / `markDelivered(id, actor)`
  still compiles (codes are optional parameters); **its expectations about the
  order status after pickup (was OUT_FOR_DELIVERY, now PICKED_UP for new offers)
  and after acceptance (now ASSIGNED) will need updating in the QA phase.**

### Pending confirmation
- Self-cancel policy for the new statuses (extension of D10): ACCEPTED/ASSIGNED
  blocked like PREPARING/READY; PICKED_UP goods-only like OUT_FOR_DELIVERY;
  FAILED/RETURNED/DISPUTED via support.
- Substitute pricing rule: customer never pays more than the original line.

### Files

| File | Purpose |
|---|---|
| `src/server/db/schema.ts` | Order enum values; `order_item_fulfilment` enum + item substitution columns; `orders.accepted_at/packed_at/refunded_paise`; delivery handover columns + `FAILED` |
| `drizzle/0020_fulfilment_and_delivery_handover.sql` (+ meta) | Migration — **not applied anywhere** |
| `src/server/services/orders.ts` | Transition table, compiler-checked paid statuses, labels, notifications, cancellation (net refund, fulfilment-aware restock, self-cancel gates) |
| `src/server/services/fulfilment.ts` | New — accept/reject/start/pick/substitute/remove/decide/ready |
| `src/server/services/delivery-assignment.ts` | Accept → ASSIGNED + pickup code; skip declined riders; offer expiry; pickup code check; start delivery + OTP; OTP-verified delivery; failed delivery; operator confirmation; dispatch + cron sweep; reassign guards; `toRiderView` |
| `src/server/services/delivery-earnings.ts` | FAILED deliveries earn |
| `src/server/services/notifications.ts`, `audit.ts` | New notification types and audit actions |
| `src/server/api/cron-auth.ts` | Shared cron bearer check (new route only) |
| `src/app/api/orders/[id]/fulfilment/route.ts` | New |
| `src/app/api/orders/[id]/items/[itemId]/substitution/route.ts` | New |
| `src/app/api/orders/[id]/confirm-delivery/route.ts` | New |
| `src/app/api/cron/delivery-dispatch/route.ts` | New |
| `src/app/api/orders/[id]/status/route.ts` | READY via fulfilment; RETURNED; DISPUTED (ops only) |
| `src/app/api/delivery-orders/[id]/route.ts` | pickup code, start, OTP, fail; sanitised responses |
| `src/app/api/delivery-partner/deliveries/route.ts` | Sanitised responses |
| `src/components/shop-order-manager.tsx`, `src/app/shop/orders/page.tsx` | Accept/reject, picking, substitutes, pack/ready, pickup code, failed/returned handling |
| `src/components/delivery-partner-dashboard.tsx` | Code entry, start delivery, OTP, failed delivery |
| `src/components/substitution-decision.tsx`, `src/app/orders/page.tsx` | Customer substitution decision, refunds shown, delivery OTP |
| `src/components/ui.tsx` | Badge tones for new statuses |
| `API.md` | Documented |

### Deployment notes
- Apply 0017 → 0018 → 0019 → 0020 in order (test DB first). 0020 adds enum
  values (`ALTER TYPE … ADD VALUE`), fine inside the migrator's transaction
  because nothing in it uses them.
- Schedule `POST /api/cron/delivery-dispatch` every minute on each host (same
  Bearer `CRON_SECRET` as daily-orders). Without it, expired offers are only
  re-offered when a rider rejects or a shop presses "Find rider now".

### Testing handoff (Slices 3–4 — not performed here)
- Shop: accept; reject with reason (full refund, stock restored, customer notified); start picking; pick lines; ready with/without explicit picks
- Substitution: propose (same shop, buyable, same unit count, price capped at original); customer approve (stock consumed, difference refunded) / reject (line refunded); READY blocked while pending; all lines removed → order cancelled with the remainder refunded; refunded total shown to customer
- Cancellation after partial refunds refunds only the remainder; restock skips removed lines and returns substitutes
- State machine: every allowed/blocked transition; self-cancel gates for ACCEPTED/ASSIGNED/PICKED_UP/FAILED/RETURNED/DISPUTED; `order_status_history` row per change
- Dispatch: READY triggers an offer; no rider → shop notified once; cron retries; offer expiry after 2 min; declined/expired rider not re-offered; concurrent orders don't double-book a rider
- Rider: accept only while READY (order → ASSIGNED, pickup code appears for the shop only); wrong/right pickup code; start delivery → OTP visible to the customer only; wrong OTP counting and 5-attempt lock; delivered → earnings; failed delivery → FAILED, earnings, shop notified; returned → cancel & refund
- Operations: confirm-delivery override (permission, proof note, audit); reassign blocked after pickup, ASSIGNED → READY on reassign
- Security: rider API/page responses never contain `pickupCode` / `deliveryOtp`; shop page never contains the OTP
- Legacy: an order accepted/picked up before migration still completes; subscription orders CONFIRMED → PREPARING still work; shops without platform delivery keep manual READY → DELIVERED
- Existing integration tests in `tests/integration/delivery-assignment*.test.ts`, `order-cancel-refund.test.ts`, `orders-status-route.test.ts` need their expectations reviewed for the new statuses

---

## Vertical Slice 6 — finance, settlement, reconciliation (2026-09-24)

The brief for this stage also arrived truncated (after Part B). Decisions
taken with the user (D6): commission % by shop type with per-shop override;
platform keeps the delivery fee and pays riders; weekly batches.

### Status changes

| ID | Previous | New | Change |
|---|---|---|---|
| GS-061 | YET TO START | COMPLETED | Commission rates (default / shop type / shop), rate snapshotted per delivered order |
| GS-062 | YET TO START | COMPLETED | Weekly shop settlements: DRAFT → APPROVED → PAID (bank reference), 2-day hold after delivery, disputes excluded, cancel releases items |
| GS-063 | IN PROGRESS | IN PROGRESS | Earnings unchanged (base + per km); now batched into payouts. Slot/incentive rules still open |
| GS-064 | YET TO START | COMPLETED | Weekly rider payouts from unpaid earnings, same lifecycle |
| GS-031 | YET TO START | COMPLETED | Reconciliation exception queue (order vs wallet, delivered without snapshot, gateway vs wallet credit, settlement drift) |
| GS-057 | IN PROGRESS | IN PROGRESS | Refund of delivered/disputed orders (full/partial, charged to shop share or platform). Return-pickup workflow still open |
| WF-010 | YET TO START | COMPLETED | GMV → commission → delivery fee → refunds → adjustments → shop settlement → rider payout → reconciliation |
| KPI-001 (GMV), KPI-009 (refund rate inputs) | IN PROGRESS / YET TO START | COMPLETED / IN PROGRESS | Finance summary for any period |
| NAV-010 | YET TO START | COMPLETED | `/shop/finance` |
| NAV-012 | IN PROGRESS | COMPLETED | Rider payouts list |
| RBAC-011 / RBAC-012 | IN PROGRESS | COMPLETED | ORDER_REFUND for operator/admin; settlement visibility per role |

### Money rules
- Payment link (Part A): orders are paid from the wallet; the wallet debit
  (`wallet_transactions`, `order_id`) is the payment record (method WALLET,
  reference = ledger id). Gateway top-ups stay in `payments`. No second
  payment system.
- `order_financials` is written inside the DELIVERED transition: goods =
  order subtotal after removed/substituted lines; GMV = goods + delivery fee;
  commission = round(goods × rate); shop payable = goods − commission.
- After-delivery refund charged to the shop deducts only the shop's share
  (refunded goods − commission on them), never the delivery fee; orders
  delivered before this release have no snapshot, so their refunds are
  platform-borne.
- Separation of duties: operators prepare and refund; only admins approve
  and mark paid.

### Files

| File | Purpose |
|---|---|
| `src/server/db/schema.ts` | `commission_rates`, `order_financials`, `financial_adjustments`, `shop_settlements`, `rider_payouts`, `delivery_partner_earnings.payout_id` |
| `drizzle/0021_finance_ledger_settlements.sql` (+ meta) | Migration — **not applied anywhere** |
| `src/server/services/finance.ts` | New — all finance logic |
| `src/server/services/orders.ts` | DELIVERED hook → `recordOrderFinancials` |
| `src/server/authz/permissions.ts` | FINANCE_VIEW / PREPARE / MANAGE, ORDER_REFUND, SETTLEMENT_VIEW_OWN |
| `src/server/services/audit.ts` | Finance audit actions |
| `src/app/api/finance/**`, `src/app/api/cron/finance-weekly/route.ts` | New APIs |
| `src/app/admin/finance/page.tsx`, `src/components/finance-actions.tsx` | Finance console |
| `src/app/shop/finance/page.tsx` | Shop statements |
| `src/app/delivery-partner/page.tsx` | Rider payouts |
| `src/components/site-header.tsx` | Finance nav links |
| `API.md` | Documented |

### Deployment notes
- Apply 0021 after 0017–0020. Set a platform default commission in
  `/admin/finance` before go-live (until then commission is 0%).
- Schedule `POST /api/cron/finance-weekly` weekly (e.g. Monday 06:00 IST).

### Testing handoff (Slice 6 — not performed here)
- Commission resolution order (shop > shop type > default > 0%); rate change affects only later deliveries; audit entry
- DELIVERED creates exactly one snapshot (rider OTP path, shop self-delivery path, operator confirmation, dispute resolved → DELIVERED again); values after removed/substituted lines
- Settlement preparation: hold period, dispute/refund-pending exclusion, carry-over of older items, re-run safety, Monday validation, cancel releases items, approve → pay requires reference; operator cannot approve/pay
- Rider payouts: batching of unpaid earnings (incl. failed-delivery and cancelled-after-pickup earnings), cancel releases
- After-delivery refund: partial and full (→ REFUNDED), shop-share maths, PLATFORM charge, over-refund rejected, double submit with same requestId refunds once, legacy order without snapshot
- Manual adjustment ± into next settlement
- Summary figures for a period; reconciliation flags each exception type and stays empty when books agree
- Shop `/shop/finance` and rider payouts show only their own data

---

## Slice 6 revision — full finance brief (2026-09-24)

The complete brief arrived after the first finance pass. Migration 0021 had
not been applied anywhere, so it was regenerated for the fuller model rather
than patched.

### Added / changed against the first pass

| Part | Change |
|---|---|
| A payment link | `order_financials.customer_id`, `payment_transaction_id` (the wallet debit); trace shows payment method/status/reference and promotional part |
| B GMV | discount (promotional credit spent) tracked per order and in the summary; summary adds gateway payments and all wallet refunds |
| C commission | commission journalled per order (shop DEBIT / platform CREDIT); status = its settlement's status |
| D settlement | `refunds_paise` split from `adjustments_paise`; full lifecycle incl. PROCESSING, FAILED (retry), REVERSED (items released, REVERSAL journalled) |
| E gig earnings | each earning journalled when created; rider view lists earnings with status (UNPAID / payout status) and adjustments |
| F payout | `rider_payouts.gross_paise`, `adjustments_paise`, net `amount_paise`; status PENDING/ELIGIBLE/PROCESSING/PAID/FAILED/REVERSED (+CANCELLED) |
| G adjustments | types SHOP / RIDER / DELIVERY / MARKETPLACE + REFUND_SHOP / REFUND_PLATFORM; party, status (PENDING/SETTLED/RECORDED), wallet transaction reference for refunds |
| H reconciliation | persisted `reconciliation_records` (UNMATCHED/MATCHED/PARTIAL/EXCEPTION/RECONCILED) for ORDER, PAYMENT, RIDER, SETTLEMENT, PAYOUT; resolve with a note |
| I ledger | `finance_ledger_entries` journal (entity, type, credit/debit, amount, currency, source, reference, status) |
| J admin view | payables per shop/rider, adjustments, reconciliation counts, journal in the order trace |
| K operator | operators lose global finance/prepare rights; new `FINANCE_EXCEPTIONS_VIEW` + `/admin/finance/exceptions` (no settlement/payout totals) |
| O exceptions | failed/pending payments, refunds pending, cancellations, delivery adjustments, missing earnings, failed/reversed batches, overdue settlement |
| M subscriptions | no change needed: subscription orders are normal orders paid by a wallet debit carrying `order_id` — they snapshot, settle and refund like any order |
| N wallet | no change: wallet transactions already carry customer, order, payment, type (credit/debit/refund) and an idempotency reference |
| P audit | every rate change, refund, adjustment, batch transition and reconciliation run/resolution is audited |

### Potential issues — require ChatGPT QA verification
- `postLedger` is called inside the same transaction as the business event; a
  ledger insert failure would roll the event back (intended, but new behaviour
  for the DELIVERED transition and earnings credit).
- Reconciliation ORDER_PAYMENT counts every COMPLETED wallet row for the order;
  subscription orders retried after WALLET_INSUFFICIENT should net correctly,
  but verify.
- `startOf()` uses `APP_TIMEZONE` for date boundaries — verify week edges in IST.

### Files (in addition to the first pass)
`src/server/services/finance.ts` (rewritten), `src/server/services/delivery-earnings.ts`
(journal hook), `src/app/api/finance/{reconciliation/[id],exceptions,ledger,payables}/route.ts`
(new), settlement/payout/adjustment/reconciliation routes (updated),
`src/app/admin/finance/exceptions/page.tsx` (new), admin/shop/rider finance
pages, `finance-actions.tsx`, `ui.tsx` (badge tones), `site-header.tsx`,
`permissions.ts`, `audit.ts`, schema + regenerated `drizzle/0021_finance_ledger_settlements.sql`.
