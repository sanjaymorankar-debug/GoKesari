# Order lifecycle backlog: SM-002, SM-004, GS-027, GA-005, NEW-007 (October 2026)

Five backlog items, built on the F1 status models (migration 0042) and the
F5 delivery slots (migration 0045). Everything that changes what a customer,
shop or rider does is behind a business rule (Admin → Business rules) and
**off by default**. The exceptions are the new states themselves (SM-002,
SM-004), which only rename or split states and keep every existing flow
working. `scripts/enable-new-features.sql` switches the rules on (used on
test); `scripts/disable-new-features.sql` switches them off.

| Item | What it adds | Rule (default) | Where |
|---|---|---|---|
| SM-002 | Shop onboarding split into **KYC pending → payment pending → verified**. Admin can approve only a VERIFIED shop. Owner and admin see the stage and the next step. | Approval gate follows `statusModels.enforceTransitions` (true) | `lib/shop-onboarding.ts`, `services/shop-onboarding.ts`, `/admin` approvals, `/shop` |
| SM-004 | Subscription **DRAFT** and **RENEWAL_PENDING** states. Every delivery date has its own status: SCHEDULED / SKIPPED, then the order's own status. | `subscriptionRenewal` (term end 3 days' notice, payment due 1 day; on) | `services/subscription-schedule.ts`, `services/subscription-renewal.ts`, `/subscriptions`, `/admin/subscriptions` |
| GS-027 | Customer picks a **date and a time slot** for a scheduled delivery. Only future slots inside shop hours, after the cut-off and with places left are offered. The place is re-checked under a lock at checkout. | `scheduledSlots.enabled` (false), 2-hour slots, 3 days ahead, 60-min cut-off | `services/scheduled-slots.ts`, `GET /api/checkout/scheduled-slots`, cart |
| GA-005 | **Rider batching**: several orders in one trip. Gives the rider an ordered pickup/drop list and keeps each order's own status. A rider on a compatible trip is preferred over an idle rider a little further away. | `batching.enabled` (false), 2 per trip, 0.5 km pickups, 45° drops | `services/delivery-trips.ts`, `delivery-assignment.ts`, rider trip card |
| NEW-007a | **Tax invoice** per delivered order: a tax invoice (CGST+SGST or IGST) for a GST-registered shop, otherwise a bill of supply. Numbered per shop per financial year. HTML page and PDF download. | `invoicing.enabled` (false) | `services/invoices.ts`, `/invoices/[id]`, `/api/invoices/[id]/pdf` |
| NEW-007b | **Photo proof of delivery**: the rider must upload a photo before marking an order delivered. JPEG/PNG/WebP within the image limits; private to the order's people. | `deliveryProof.photoRequired` (false) | `services/delivery-proofs.ts`, `POST /api/delivery-orders/[id]/proof` |
| NEW-007c | **Shop acceptance timeout**: the shop is reminded half-way through. An order not accepted in time is cancelled with a full refund and restock. Missed orders are counted on the shop dashboard. | `shopAcceptance.enabled` (false), 10 min | `services/shop-acceptance.ts`, `POST /api/cron/shop-acceptance` |

## States and transitions

**Shop (SM-002).**
- `PENDING` is replaced by three stages, worked out from the data:
  - `KYC_PENDING`: a mandatory seller document (PAN, GSTIN, Shop Act, plus FSSAI for food) is not VERIFIED.
  - `PAYMENT_PENDING`: documents are verified, but the registration fee is not settled.
  - `VERIFIED`: both are done, and the shop is waiting for admin approval.
- The stages may move among themselves, for example when a document expires or a payment is reversed.
- Only `VERIFIED` may become `ACTIVE`/`PAUSED`. `REJECTED`, `SUSPENDED` and `CLOSED` are unchanged.
- A database trigger re-works out the stage when a document, the fee or the shop's categories change.

**Subscription (SM-004).**
- `DRAFT` is saved but not started: no orders, and no checks against the wallet.
  - It becomes `ACTIVE` through `POST /api/subscriptions/{id}/activate`.
- `RENEWAL_PENDING` is set by the daily run in two cases:
  - **TERM_END**: the end date is within the notice days.
  - **PAYMENT_DUE**: the wallet will not cover the next deliveries.
- Deliveries continue while renewal is pending.
  - `POST /api/subscriptions/{id}/renew` extends the end date.
  - A wallet top-up clears PAYMENT_DUE.
- A term that ends without renewal completes.
- `CANCELLED` and `EXPIRED` are final. Nothing returns to `DRAFT`.

**Subscription delivery (SM-004).**
- `subscription_deliveries` holds one row per subscription per date: `SCHEDULED` or `SKIPPED` while there is no order yet. After that it carries the order's own status (CONFIRMED … DELIVERED / FAILED / CANCELLED …).
- Triggers keep it in step with the order.
- Once an order exists, the row never goes back to SCHEDULED or SKIPPED (a database check).

## Server enforcement

- **Shop and subscription states:** the F1 trigger checks `status_transition_rules`, which is replaced for SHOP and SUBSCRIPTION by migrations 0051 and 0052. Every change is logged in `status_changes`.
- **Shop approval:** `approveShopTransaction` refuses a shop that is not VERIFIED, and names the documents still missing.
- **Scheduled slot:** the slot is re-validated and counted under the same advisory lock as F5, so two customers cannot both take the last place.
- **Batching:** compatibility is re-checked under the rider's row lock before the offer is made.
- **Photo proof:** `markDelivered` refuses without a photo while the rule is on.
- **Acceptance timeout:** the cancel re-checks `status = CONFIRMED` under the order's row lock, so a shop accepting at the same moment always wins.
- **Invoices:** the counter row is locked and incremented in the issuing transaction. A unique index on `order_id` makes a second, concurrent issue return the first invoice.

## Migrations and rollback

| Migration | Adds | Data migration | Rollback |
|---|---|---|---|
| 0051_shop_onboarding_states | `lifecycle_shop` with the three stages, `shop_kyc_complete()`, touch triggers on `seller_verifications` and `shop_product_categories` | Every PENDING shop is re-worked out into its stage and logged (`detail.migration = 0051`) | `scripts/rollback-0051.sql` |
| 0052_subscription_states | `DRAFT`, `RENEWAL_PENDING`; `subscriptions.renewal_reason / renewal_due_date`; `subscription_deliveries` and its triggers | Existing subscription orders copied in with their status; upcoming skips written as SKIPPED | `scripts/rollback-0052.sql` |
| 0053_scheduled_slots | `orders.scheduled_slot_start / scheduled_slot_end`, `delivery_slot_capacities.scheduled_per_slot` | — (nullable) | `scripts/rollback-0053.sql` |
| 0054_delivery_trips | `delivery_trips`, `delivery_orders.trip_id` | — (nullable) | `scripts/rollback-0054.sql` |
| 0055_order_completion | `orders.accept_by_at / accept_reminder_sent_at`, `shop_sla_events`, `delivery_proofs`, `tax_invoices`, `invoice_counters`, image purpose `DELIVERY_PROOF` | — | `scripts/rollback-0055.sql` |

Roll back newest first (0055 → 0051). First switch the features off with
`scripts/disable-new-features.sql`. After each script, delete that
migration's row from `drizzle.__drizzle_migrations`. Rollback 0051 puts every
onboarding stage back to PENDING. Rollback 0052 cancels DRAFT subscriptions
(which never had orders) and returns RENEWAL_PENDING ones to ACTIVE.

## Cron

| Endpoint | Schedule | Purpose |
|---|---|---|
| `POST /api/cron/shop-acceptance` | every minute | Sends reminders and cancels missed orders. Does nothing while the rule is off. |
| `POST /api/cron/daily-orders` (existing) | daily 05:00 IST | Also evaluates renewals (SM-004) and writes the schedule horizon |
| `POST /api/cron/delivery-dispatch` (existing) | every minute | Also dispatches scheduled-slot orders once their lead time is reached (GS-027) |

## Tests

New integration suites (real PostgreSQL):
- `tests/integration/shop-onboarding-states.test.ts`
- `subscription-states.test.ts`
- `scheduled-slots.test.ts`
- `rider-batching.test.ts`
- `order-completion.test.ts`

Updated: `status-models.test.ts`, `registration-fees.test.ts`,
`shop-duplicate-registration.test.ts`. Full suite: **88 files, 1214 tests,
all passing**.

## Before relying on invoices

Invoices take tax out of the tax-inclusive price at each product's
`gst_rate_bp`. A product with no rate uses `invoicing.defaultGstRateBp` (0),
and its line is marked. Have a CA confirm the HSN codes, the rates, the
bill-of-supply wording for unregistered or composition shops, and the
treatment of GoKesari's delivery fee. The fee is not on the shop's invoice.
