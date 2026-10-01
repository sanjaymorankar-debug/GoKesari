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

---

## Phase 2 — Society + Ratings + Subscription expansion + workflow completion (2026-09-25)

Branch `dev/phase2-society` (from `dev/phase1-go-live`). Development only — not tested.

### Status changes

| ID | Previous | New | Implementation |
|---|---|---|---|
| GS-044 | YET TO START | COMPLETED | Society registration → operator verification (verify/reject/suspend/reinstate); `societies`, `/society`, `/admin/societies` |
| GS-005 | YET TO START | COMPLETED | Membership (request → approve), address ↔ society link, `orders.society_id` at checkout and subscription generation |
| GS-045 | YET TO START | COMPLETED | Authorised rider list by mobile; add / revoke (immediate) / preferred; audited |
| GS-040 / GA-001 | YET TO START | COMPLETED | Dispatch filters to listed riders when the society is exclusive (non-empty list) |
| GA-002 | YET TO START | COMPLETED | Listed and preferred riders ranked ahead (`DISPATCH_WEIGHTS`) |
| GA-007 | YET TO START | COMPLETED | Reliability (30-day completions vs failures/declines, smoothed) in ranking |
| GA-008 | YET TO START | COMPLETED | Fairness penalty per offer already received today |
| GS-046 | YET TO START | COMPLETED | Society security notification on rider acceptance (opt-in) |
| GS-047 | YET TO START | COMPLETED | Society gate notes + customer landmark/instructions on the rider's active job |
| WF-004 | YET TO START | COMPLETED | Identify society → rider list → filter/priority → security notification |
| NAV-014 | YET TO START | COMPLETED | Society dashboard `/society/{id}` (rules, residents, riders, shops, deliveries) |
| RBAC-009 | YET TO START | COMPLETED | Society-scoped roles via membership; `SOCIETY_MANAGE_ANY` for platform staff |
| GS-002 | IN PROGRESS | COMPLETED | Society roles now functional (scoped), SOCIETY_ADMIN as navigation role |
| GS-059 | YET TO START | COMPLETED | Shop rating: eligibility, one per order, aggregate, public reviews (anonymous), moderation |
| GS-060 | YET TO START | COMPLETED | Rider rating: eligibility (platform rider delivered), aggregate, visible to the rider and operations only |
| GS-026 | IN PROGRESS | COMPLETED | Checkout refuses a shop that does not deliver to the chosen address (radius / PIN / society partner) |
| GS-056 | IN PROGRESS | COMPLETED | "Report a problem" on an order → grievance linked to the order |
| WF-007 | IN PROGRESS | IN PROGRESS | Report → refund (finance) path complete; return pickup still open |
| GS-049 | IN PROGRESS | COMPLETED | Weekly schedules on chosen weekdays (existing) + subscription orders now carry address/society so they flow through dispatch |
| GS-051 / SM-004 | COMPLETED / IN PROGRESS | COMPLETED / IN PROGRESS | Lifecycle guards (final states locked), history `subscription_events`, resume/cancel notifications |
| WF-006 | IN PROGRESS | COMPLETED | Subscription orders get the delivery snapshot + society → shop fulfilment → rider dispatch → settlement |

### Fixes found by inspection
- `/subscriptions/{id}` let any non-CUSTOMER role (shop owners, riders, society admins) view others' subscriptions — now owner or `SUBSCRIPTION_MANAGE_ANY` only.
- `resumeSubscription` could revive a CANCELLED subscription — now refused.
- Subscription-generated orders had no delivery address snapshot (riders got no drop address).

### Database — migration `0022_society_ratings_subscription_history.sql` (not applied anywhere)
New tables: `societies`, `society_members`, `society_riders`, `society_shops`, `order_ratings`, `subscription_events`.
New columns: `addresses.society_id`, `orders.society_id` (+index), `grievances.order_id`, `shops.rating_avg_x100/rating_count`, `delivery_partners.rating_avg_x100/rating_count`.
New enums: society status / member role / member status / link status, rating target / status.

### Known gaps
- Society map pin: set via API (lat/lng) — no map picker on the society form yet (PIN matching works without it).
- Shop operator (staff) role not introduced — shops remain single-owner (no approved requirement row).
- Return pickup / replacement (WF-007) and rating comment moderation for rider feedback text in UI.

### Testing handoff (not performed here)
- Society: register → operator verify/reject/suspend/reinstate; duplicate name+PIN refused; registrant is ADMIN and gets SOCIETY_ADMIN nav role on verification
- Membership: request (only verified), approve/decline by ADMIN/OPERATOR, role change by ADMIN only, last admin protected, leave/remove clears address links
- RBAC: residents cannot open `/society/{id}` or call admin APIs; one society's staff cannot act on another; platform operator can
- Address link only to a verified society the user actively belongs to; order `society_id` set only then
- Dispatch: exclusive society with listed riders → only listed riders offered; non-exclusive → listed/preferred ranked first; empty list never blocks; reliability/fairness ordering; no rider → shop notified (society wording)
- Security notification only when enabled; rider sees society gate notes and customer notes on the active job only
- Society partner shops appear first for residents and are serviceable for them
- Checkout with an address outside a shop's zone → refused with the shop name; without address unchanged
- Ratings: only own DELIVERED orders, 30-day window, one per target, rider rating only when a platform rider delivered, aggregates update, moderation hide/restore updates averages, public reviews anonymous, rider sees own average
- Subscriptions: pause/resume/skip/cancel refused on CANCELLED/COMPLETED; history rows for each action and payment failure; resume/cancel notifications; generated orders carry address snapshot + society and dispatch a rider
- Report a problem: creates a ticket linked to the order; cannot report on someone else's order
- Regression: existing checkout (no address), delivery flow, finance snapshot on DELIVERED

---

## Phase 3 — remaining "yet to start" features (2026-09-27)

Branch `dev/phase3-growth` (from `dev/phase2-society`). Development only — not tested.

### Status changes

| ID | Previous | New | Implementation |
|---|---|---|---|
| GS-003 | YET TO START | COMPLETED | `user_role_grants`; `users.role` = active role; header role switcher; `/api/me/roles`; admin revoke; shop / rider / society flows grant alongside existing roles; staff roles exclusive |
| GS-030 | YET TO START | COMPLETED | COD at checkout with risk limits; shop opt-in; rider/operator cash confirmation; collection → finance adjustments netted in batches; deposits `/admin/cod`; COD refunds as wallet credit; reconciliation counts cash |
| GS-052 | YET TO START | COMPLETED | Segments by PIN, society, delivered orders, recency, lapse, spend; consent always required; counts only |
| GS-053 | IN PROGRESS | COMPLETED | Shop campaigns with budget (max recipients), shop rate limit and customer frequency caps |
| WF-009 | YET TO START | COMPLETED | Audience → consent → budget → operations approval → send → tracking (opened, converted, revenue) |
| NAV-009 | YET TO START | COMPLETED | `/shop/marketing` (customers, segments, campaigns, COD setting). Vouchers/referrals stay admin tools |
| KPI-015 | YET TO START | COMPLETED | Campaign conversion within the attribution days |
| GS-068 | YET TO START | COMPLETED | 11 rules (customer, rider, shop), hourly cron, review queue `/admin/risk`; open HIGH customer flag pauses COD |
| KPI-002…008, 010…014 | YET TO START | COMPLETED | `analytics.ts` — fill, acceptance, pick-pack, assignment, delivery, on-time, cancellation, repeat, subscription retention, rider acceptance, rider utilisation (new `delivery_partner_sessions`), shop retention |
| KPI-001 | COMPLETED | COMPLETED | Daily GMV trend added |
| KPI-009 | IN PROGRESS | COMPLETED | Refund rate (count and value) |
| GS-069 / NAV-018 | IN PROGRESS | COMPLETED | `/admin/analytics` (marketplace) and `/shop/analytics` (own shop) |

### Database — migration `0023_phase3_growth_cod_risk_roles.sql` (not applied anywhere)
- New tables: `user_role_grants`, `delivery_partner_sessions`, `customer_segments`, `marketing_campaigns`, `campaign_recipients`, `risk_flags`
- New columns: `orders.payment_method` (default WALLET), `orders.checkout_key` (unique), `orders.cod_collected_at`, `shops.cod_enabled`
- New enum values: `financial_adjustment_type` COD_CASH_COLLECTED / COD_CASH_DEPOSITED; `ledger_entry_type` COD_CASH
- Backfill: a grant for every existing non-customer role, every rider and every shop owner; open sessions for riders online now
- Requires 0022 first (staging and production)

### Deployment notes
- Apply 0022 then 0023. No new environment variables.
- Schedule `POST /api/cron/risk-rules` hourly (same `CRON_SECRET` as the other crons).

### Decisions taken with defaults (confirm or change)
- COD limits: ₹2,000 per order, 2 open COD orders per customer, paused after 2 failed COD deliveries in 90 days (`COD_LIMITS` in `cod.ts`)
- COD cash still held at batch time is deducted from the rider payout / shop settlement; a batch can then be negative (the rider/shop owes the platform) — collection of a negative batch is manual
- Marketing: 2 campaigns per shop per week; per customer 1 per shop and 3 total per week; attribution 7 days by default (`MARKETING_LIMITS`)
- Risk thresholds as listed in `risk.ts`; flags never act on their own except pausing COD

### Known gaps
- Negative payouts / settlements (COD cash held > earnings) have no in-app collection flow
- Campaigns are in-app notifications only (email/SMS/WhatsApp providers are GS-074)
- A campaign is marked SENT before messages are written; if sending fails midway, sent_count reflects what was written
- KPI "placed" requires an order_status_history CONFIRMED row — orders created before history existed are not counted
- Rider utilisation relies on online sessions recorded from this release on (backfilled only for riders online at migration time)

### Testing handoff (not performed here)
- GS-003: shop owner who applies as rider keeps SHOP_OWNER and can switch; switching only to held roles; admin demotion from OPERATOR removes the grant; revoking the active role falls back to CUSTOMER; bootstrap admins get an ADMIN grant; existing users keep access after migration backfill
- GS-030: COD refused for B2B, without address, shop not opted in, total > ₹2,000, 3rd open COD order, after 2 failed COD deliveries, with open HIGH risk flag; COD order confirmed unpaid; cancel before delivery → no refund, stock restored; rider cannot mark delivered without cash confirmation; operator override needs cashCollected; shop self-delivery collects as SHOP; delivered → paid, finance snapshot present, adjustment −total; deposit ≤ held; next payout/settlement nets cash; refund after delivery → wallet credit; reconciliation ORDER_PAYMENT matched for COD; checkout replay returns the same COD orders
- Analytics: each KPI against hand-computed fixtures; shop owner sees only own shop; operator/admin marketplace; customer forbidden
- Marketing: segments counts only; consent required; lapsed/ordered-within conflict rejected; rate limit on submit; approval required before send; frequency caps; budget cap; double send impossible; opened/converted counts; rejected campaign editable and resubmittable; operations cannot edit shop campaigns
- Risk: each rule raises one OPEN flag per subject; re-run refreshes (no duplicate); dismiss / action with note; HIGH customer flag blocks COD; cron auth
- Regression: wallet checkout unchanged (paymentMethod default), B2B checkout, rider flow for prepaid orders, finance batches, reconciliation for wallet orders

---

## Phase 4.3 — Admin order monitoring (2026-09-28)

### Completed
- `/admin/orders`: staff order list (latest 100) with status / shop / date-range filters in the URL
- Rows show order number, placed time, shop, customer, status, amount, and the live rider assignment
- Quick actions reuse the existing `POST /api/orders/[id]/assign`: "Assign rider" (READY with no live delivery), "Reassign" (live OFFERED/ACCEPTED/PICKED_UP delivery, asks for a reason)
- Page gated by ORDER_VIEW_ANY; actions shown only with DELIVERY_ORDER_MANAGE_ANY (the API enforces it again)

### Files
- `src/app/admin/orders/page.tsx` (new)
- `src/components/order-monitoring-table.tsx` (new)
- `src/components/order-filters.tsx` (new)
- `src/server/services/orders.ts`: `listOrdersForMonitoring`, `orderStatusOptions`, `listShopOptions`, `MonitoredOrder`

### APIs / DB
- No new API routes, no migrations

### Known gaps
- "Extend deadline" from the plan is not built: orders have no deadline/SLA column; it needs a schema decision
- No staff order-detail page, so order numbers are not links
- No pagination beyond 100 rows; no live refresh (reload or re-filter)
- If an order ever had two live delivery_orders rows at once it would appear twice

### Testing handoff (not performed here)
- Filters: each alone and combined; invalid status / shopId / date in the URL is ignored, not a 500
- Customer and shop owner are redirected; operator and admin see all shops
- Assign rider on a READY order; Reassign with and without a reason; cancel on the prompt does nothing; API error shows inline
- Order with rejected + accepted offers shows once, with the accepted rider

---

## Tasks 7–11 type-error remediation (2026-09-29)

Tasks 7–11 had been written without a typecheck (47 errors). Each was rewired onto the existing services instead of the invented stubs; `tsc --noEmit` now passes for the whole repo and eslint passes on every touched file.

### Completed
- Tracking: `GET /api/tracking/[orderId]` reads the rider's location from the existing `delivery_partners.last_location_*` columns (migration 0012). Access is limited to the customer, the shop owner, ORDER_VIEW_ANY and the assigned rider. Coordinates are shown only after pickup, and only from readings taken after pickup. ETA is null rather than NaN. Redundant `POST /api/tracking/update` deleted (riders already use `/api/delivery-partner/location`). Un-migrated `tracking_events` table removed from schema.ts. `src/lib/tracking.ts` reuses `haversineDistanceKm`; the inverted redaction logic was removed.
- Admin dashboard: now uses `getMarketplaceKpis(defaultWindow(1))` and the same gate as `/admin/analytics`. Added `getLiveOperations()` to analytics.ts (add-only): orders in flight by status, riders online/busy. Removed the fake trends, the empty payment chart and the invented top-shops list. Dead links now point to `/admin/finance/exceptions`, `/admin/risk` and `/admin`. The unused `/api/admin/kpis` was deleted; it duplicated `/api/analytics/kpis`.
- Gig: uses `getMyDeliveryPartnerProfile`, `getPartnerEarningsSummary`, `getMyActiveDeliveryDetail` and `listMyDeliveryHistory`. `/gig/orders` is now "My deliveries" (push dispatch, no order pool). All actions link to the existing `/delivery-partner` app. Invented fields (insurance, bank account, acceptance rate) removed.
- Notification preferences form: no per-user email-preference storage exists, so it now uses the existing `PUT /api/consents/marketing`.

### Files
- Changed: src/lib/tracking.ts, src/app/api/tracking/[orderId]/route.ts, src/components/live-tracking-map.tsx, src/app/admin/dashboard/page.tsx, src/components/kpi-card.tsx, src/components/analytics-chart.tsx, src/server/services/analytics.ts, src/app/gig/profile/page.tsx, src/app/gig/orders/page.tsx, src/components/gig-earnings-card.tsx, src/components/notification-preferences-form.tsx
- Deleted: src/app/api/tracking/update/route.ts, src/app/api/admin/kpis/route.ts
- schema.ts: trackingEvents removed (no net diff against HEAD)

### APIs / DB
- Removed: POST /api/tracking/update, GET /api/admin/kpis (both new this sprint, never released)
- No migrations

### Known gaps
- HIGH: nothing posts rider location during a delivery (no caller of `/api/delivery-partner/location`), so tracking never shows coordinates in practice
- LiveTrackingMap and NotificationPreferencesForm are not mounted anywhere. The form now duplicates MarketingConsentToggle on /profile.
- /admin/dashboard overlaps /admin/analytics; /gig overlaps /delivery-partner; neither /admin/dashboard nor /admin/orders is in site-header nav
- Suspended riders keep their active delivery (the rider services don't check APPROVED)

### Testing handoff (not performed here)
- Tracking GET: each viewer role allowed or denied; offered/rejected rider denied; coordinates only while PICKED_UP and recorded after pickedUpAt; self-delivery and retry show "not tracked"; bad uuid → 422
- Dashboard: operator vs admin vs customer gate; today KPIs match /admin/analytics for a 1-day window; in-flight counts include FAILED; risk tile hidden without RISK_REVIEW
- Gig: unregistered → apply CTA; non-approved → no action links; approved with/without an active job; history excludes the active row; earnings amounts per delivery
- Consent form: toggle saves, Save disabled when unchanged, error message shown

---

## Phase 4.5 — Risk review extensions on /admin/risk (2026-09-29)

### Completed
- New rule HIGH_VALUE_OUTLIER ("Unusually large order", USER, MEDIUM; defaults pending business confirmation): an order in the last 7 days of ≥ ₹2,000 and ≥ 5× the customer's average over the 90 days before it (with 3+ orders then), or ≥ ₹10,000 with fewer than 3 orders then. PERSONAL + DIRECT orders only; PENDING / PAYMENT_FAILED / WALLET_INSUFFICIENT ignored; value = total + already refunded. The summary names each order number, its amount in rupees and the multiple or prior-order count. An order already listed on a reviewed flag is not raised again. Rule count is now 12.
- /admin/risk filters: severity and subject type in the URL, combined with the status tabs; every link keeps the other filters; unknown values are ignored; "Clear filters" on an empty filtered result
- Each flag shows the subject's current account status (user / shop / rider status, or "deleted" / "not found")
- "Suspend & mark actioned" on OPEN flags when the viewer holds the subject's suspend permission and the subject is suspendable: asks for a reason (≥ 5 chars), calls the suspend endpoint, then closes the flag as ACTIONED with `Suspended: <reason>`. If the suspension worked but the flag update failed, it says so plainly.
- Suspended users are enforced (auth.ts signIn rejects non-ACTIVE; the session callback re-reads status; getCurrentUser() returns null unless ACTIVE), so a user suspend route was added

### Repair pass (2026-09-30, after two independent reviews)
- Admin protection: `suspendUser` now refuses any account holding an ACTIVE ADMIN grant (not only `users.role`, which is just the active role), the active role ADMIN, or a `PERMANENT_ADMIN_EMAILS` address. The guard is in the UPDATE's WHERE too (NOT EXISTS on `user_role_grants`) so a concurrent grant cannot slip past. `/admin/risk` no longer offers the button on an admin subject (`RiskFlagView.subjectIsAdmin`).
- Suspending a user who is an APPROVED rider suspends the rider profile first through the existing `suspendDeliveryPartner` (offline, session closed, notified with a generic reason), so a failure leaves the account untouched and retryable. The audit row records how many rider profiles were suspended.
- Suspend-shortcut copy now states the real consequences: user (rider profile suspended too, carried delivery stays assigned, subscriptions and owned shop untouched, reinstate is API only), shop (open orders not cancelled, subscribers told daily, owner not notified, reason in the audit log only, re-approve API), rider (in-flight delivery disappears from their app until ops resolve it from Orders, the rider sees the reason). The rider reason field says it is shown to the rider; the other two say internal note.
- HIGH_VALUE_OUTLIER label and summary reworded ("Unusually large order", "unusually large for this customer") so they fit both branches; the per-order parenthetical says which applied.
- 409 "already reviewed" on the flag update after a successful suspend is now reported as "another reviewer had already closed this flag", is not refreshed away, and offers a "Refresh list" button. Other flag failures keep the "WAS suspended, but could not be marked actioned" message.
- `suspendShop` is one conditional UPDATE inside a transaction with its audit row (APPROVED and not deleted in the WHERE), so a concurrent reject or suspend cannot be overwritten or audited twice.
- `/signin` explains `?error=AccessDenied` (suspended or closed account, with a link to the grievance form).
- New admin-only reinstate: `reinstateUser` + `POST /api/users/{id}/reinstate` (USER_SUSPEND, `{ reason }`, SUSPENDED to ACTIVE, audited `user.reinstated`; `AUDIT_ACTIONS.USER_REINSTATED` added in `src/server/services/audit.ts`). It restores the account only; a suspended rider profile needs reactivating from the delivery partner queue. No UI.

### Files
- `src/server/services/risk.ts`: HIGH_VALUE_OUTLIER, `ListRiskFlagsOptions` (severity, subjectType; additive), `RiskFlagView.subjectStatus`, `RiskFlagView.subjectIsAdmin`
- `src/app/admin/risk/page.tsx`, `src/app/api/admin/risk/route.ts`, `src/components/growth-actions.tsx` (`RiskSuspendButton`)
- `src/server/services/shops.ts`: `suspendShop` (APPROVED only; one conditional UPDATE + `shop.suspended` audit in a transaction)
- `src/server/services/users.ts`: `suspendUser` (ACTIVE only; not yourself; not an admin by grant, role or permanent email; suspends an APPROVED rider profile; audited `user.suspended`), `reinstateUser`, `findAdminUserIds`
- `src/server/services/audit.ts`: `USER_REINSTATED` (one line)
- `src/app/signin/page.tsx`
- New: `src/app/api/shops/[id]/suspend/route.ts`, `src/app/api/users/[id]/suspend/route.ts`, `src/app/api/users/[id]/reinstate/route.ts`
- API.md

### APIs / DB
- New: `POST /api/shops/{id}/suspend` (SHOP_SUSPEND) and `POST /api/users/{id}/suspend` (USER_SUSPEND, admin only), both `{ reason }`; `POST /api/users/{id}/reinstate` (USER_SUSPEND, admin only, `{ reason }`)
- `GET /api/admin/risk` accepts `severity` and `subjectType` and returns `subjectStatus` and `subjectIsAdmin`
- No migrations, no new permissions

### Known gaps
- No reinstate screen: a suspended user is reinstated through `POST /api/users/{id}/reinstate` only. A suspended shop can only be reinstated through `POST /api/shops/{id}/approve`, and no admin screen offers either.
- A suspended customer's subscriptions keep generating orders and debiting the wallet. Open orders carry on. A suspended user who owns a shop keeps that shop APPROVED (a rider profile is now suspended with the account).
- Suspending a shop does not notify the owner or store the reason on the shop (the reason is in the audit log only). Open orders are not cancelled and the owner can still fulfil them; its subscribers get a "Delivery unavailable" notice each day.
- A rider suspended from the queue, the risk page, or through the user suspend keeps any accepted or picked-up delivery assigned to them; it disappears from their app until operations resolve it.
- Other rules still raise a new flag an hour after a review if the condition persists (existing behaviour)
- A non-UUID id on the suspend and reinstate routes returns a generic 500, like the sibling approve and reject routes

### Testing handoff (not performed here)
- Rule: an order of ₹2,000+ at 5× the average with 3+ prior orders is flagged; 4.9× is not; ₹10,000 with 0–2 prior orders is flagged; ₹9,999 is not; B2B, SUBSCRIPTION, PENDING, PAYMENT_FAILED and WALLET_INSUFFICIENT orders are ignored both as candidates and in the average; re-run refreshes; after Dismiss, the same order is not re-raised but a new outlier order is
- Filters: each alone and combined with each status tab; invalid values ignored; links keep the other filters
- Suspend: operator sees it for shops and riders but not customers; admin sees all three; hidden when the subject is already suspended, deleted, or yourself; reason < 5 chars keeps Confirm disabled; flag closed with `Suspended: <reason>`; a suspend API error leaves the flag open; suspend OK + flag update failure shows the plain message
- Suspended user: signed out on next request, cannot sign in again and sees the AccessDenied message on /signin; an ADMIN target is refused, including an admin currently acting as CUSTOMER or SHOP_OWNER and a permanent bootstrap admin; no suspend button on an admin subject; a user who is also an APPROVED rider ends with the rider profile SUSPENDED and offline
- Reinstate: SUSPENDED to ACTIVE with a reason (audited `user.reinstated`); ACTIVE, unknown and deleted targets give 409, 404, 409; an OPERATOR gets 403; the user can sign in again; a rider profile stays SUSPENDED
- Suspend shop: a second concurrent suspend or a concurrent reject gives 409 and only one `shop.suspended` audit row
- Risk page 409: the flag closed by another reviewer just before Confirm shows "another reviewer had already closed this flag" and a Refresh list button, not the "could not be marked actioned" error

---

## Duplicate shop registration fix (2026-09-29)

Branch `fix/shop-duplicate-registration` (from `origin/staging` 8193ec6). Development only — not tested.

### Root cause
- `registerShop()` inserted unconditionally — no lookup by owner, name, address or any licence number
- The only unique keys on `shops` (`slug`, `registration_number`) are generated per insert, so identical submissions never collide
- No Shop Act or Udyam column existed; PAN was collected only after registration, AES-GCM encrypted with a random IV, so two copies of one PAN never compare equal
- The Submit button's `busy` flag was set inside a React 19 form action, whose state updates don't render until the action finishes — a double-click sent two POSTs. The same form action also made React reset the form after every server error, wiping what the owner had typed
- `/shop/register` never checked for an existing shop, the dashboard shows only the newest shop, and a rejected shop had no resubmit path

### Completed
- Identifiers on registration: Shop Act / Gumasta, PAN (+ name on card), Udyam / Udyog Aadhaar — at least one required by `POST /api/shops`; normalised in `src/lib/shop-identity.ts`; placeholders (NA, NIL, 0000…) and bare 12-digit numbers refused
- `src/server/services/shop-duplicates.ts`: Shop Act match always blocks; PAN/Udyam match blocks only at the same place (same PIN code + same name or first address line); same account + same name + same PIN code blocks; Pending/Approved/Suspended/Inactive block with the brief's messages (identifier masked, nothing about the other shop); same account's Rejected registration is updated and resubmitted; another account's Rejected one is ignored
- Race safety: transaction-scoped advisory locks per identifier, taken in sorted order; partial unique index on `shop_act_key` as the backstop; unique violation mapped to 409 in register / approve / status change
- PAN: `pan_hash` = HMAC-SHA256 under an HKDF sub-key of `PAN_ENCRYPTION_KEY` (no new env var); PAN still stored encrypted; `submitPan` runs the same guard and writes the hash
- Form: new "Business registration" section; on-blur pre-check (`POST /api/shops/duplicate-check`, rate-limited, POST so numbers stay out of URLs); `onSubmit` handler instead of a form action (button disabled at once, typed values kept on errors) + a synchronous ref guard, spinner while submitting
- `/shop/register` warns about the owner's own pending shop and explains resubmission; rejected alert on `/shop` links to resubmit
- Owners now get in-app notifications on approval and rejection (the duplicate message promises one)
- Audit: `shop.resubmitted`, `shop.duplicate_blocked` (identifiers masked)
- Read-only duplicate report (`scripts/shop-duplicate-report.sql` / `.ts`) and PAN-hash backfill (`scripts/backfill-shop-pan-hash.ts`, dry run by default)

### Database
- Migration `0024_shop_identity_dedup`: `shops.pan_hash`, `shop_act_number`, `shop_act_key`, `udyam_number`; `shops_shop_act_key_active_unique` (partial: not null, not deleted, not REJECTED); `shops_pan_hash_idx`, `shops_udyam_number_idx`; check `shops_shop_act_key_with_number`
- Additive, new columns NULL — the unique index cannot fail on existing rows. Applied nowhere.

### Deployment notes
- DEPLOYMENT.md "Migration 0024": migrate, deploy, backfill PAN hashes, run the duplicate report

### Known gaps
- Shops registered before this release have no Shop Act / Udyam number, so only the same-account name + PIN rule and PAN (after backfill) can match them
- No UI to add or correct a Shop Act / Udyam number after registration (only via resubmission of a rejected shop)
- The approval queue doesn't flag "same PAN as another shop elsewhere" (allowed as a branch)
- The report's name grouping uses Postgres `[:alnum:]`, which may treat non-Latin names differently from the app's check

### Testing handoff (not performed here)
- `tests/unit/shop-identity.test.ts`, `tests/integration/shop-duplicate-registration.test.ts` (written, not run)
- Brief's cases: new shop allowed; same PAN while pending blocked; same Udyam while approved blocked; same Shop Act with different spacing/case blocked; rejected shop updates the existing record; double-click creates one record (service-level race + browser double-click)
- Also: same PAN at another place allowed (branch); suspended blocked; another account's rejected record → new record; approve of a rejected shop whose licence is now live → 409; operator sees matched shop id; messages never show the other shop's name or full PAN; `/api/shops` 422 with no identifier, 201/409/200; pre-check CLEAR/DUPLICATE/RESUBMISSION, 422 on bad format, 429 after 20/min
- Regression: existing registration, GST/PAN and approval flows; `/shop/register` form in a browser (pending notice, spinner, PAN holder field appears)

---

## Complete in-progress features — Phases A–J (2026-09-30)

Development report, status tables, migrations, APIs, configuration and the QA hand-off
are in [COMPLETE_IN_PROGRESS_REPORT.md](./COMPLETE_IN_PROGRESS_REPORT.md);
D10 verification is in [D10_VERIFICATION.md](./D10_VERIFICATION.md);
the consolidated test plan for QA is [QA_TEST_PLAN_COMPLETE_IN_PROGRESS.md](./QA_TEST_PLAN_COMPLETE_IN_PROGRESS.md).
Migrations `0025`–`0034` are new and **not applied anywhere yet** (they were applied to a
scratch local database only, to check they run).

---

## Closed-shop ordering and IST opening hours (2026-10-02)

Development only — type-check and lint run; no functional tests.

**Why:** `isShopOpenNow` read the machine's own clock, so the server (UTC) and the browser (IST) disagreed — a React hydration error (#418) on the shop grid and wrong open/closed judgement in the cart check. Closed shops also took orders with no confirmation and no alert.

| Change | Detail |
|---|---|
| Opening hours in IST | `src/lib/shop-hours.ts` now evaluates on an IST-shifted clock; new `nextOpeningAt` and `formatShopTime` (deterministic text, safe for SSR) |
| Cart warning | `SHOP_CLOSED_NOW` message: "might be closed … opens Fri 9:00 AM … you will be asked to confirm" |
| Customer confirmation | Cart shows "may be processed once the shop opens … continue?" with Yes / No; Yes sends `acknowledgeClosedShopIds` |
| Server enforcement | `checkout` refuses a closed shop that was not acknowledged (409) |
| Alert 1 (immediate) | Shop owner gets `shop.order_while_closed` (in-app + email); customer gets `order.queued_shop_closed` |
| Alert 2 (once, on opening) | `sendShopOpeningAlerts` (called from `/api/cron/notifications`, already scheduled every minute) sends `shop.opened_orders_waiting` to the shop and `order.shop_now_open` to the customer; claimed with a conditional UPDATE so overlapping runs never double-send |
| Migration 0036 | `orders.placed_while_closed`, `expected_open_at`, `shop_open_alert_sent_at` + partial index; additive |

Files: `src/lib/shop-hours.ts`, `src/server/services/{orders,cart,cart-validation,shop-opening}.ts`, `src/components/cart-view.tsx`, `src/app/api/checkout/route.ts`, `src/app/api/cron/notifications/route.ts`, `src/server/notifications/{types,templates}.ts`, `src/server/db/schema.ts`, `drizzle/0036_*`.

Testing handoff: order from an open shop (no prompt); from a closed shop (prompt, No keeps the cart, Yes places the order); both alerts arrive once; shop with no hours is always open; Sunday/closed days; midnight boundaries; subscriptions are unchanged; hydration error gone on `/`.
