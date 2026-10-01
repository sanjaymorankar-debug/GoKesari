# Design — direct payments, tax invoicing, photo proof of delivery, shop accept timeout

**Status:** DESIGN ONLY — awaiting Opus review before implementation. No code, no migrations applied.
**Decisions taken (2026-10-01):** pay-per-order via Cashfree (D1) · shop invoices goods + platform invoices its own fees (D6) ·
auto-cancel with full refund on accept timeout · design reviewed on Opus before build.
**Process rules carried over:** development only (typecheck/lint, no functional tests, no live-gateway calls), additive migrations,
every threshold admin-tunable in `platform_settings`, every money movement idempotent and journaled, QA is a separate phase.

---

## 0. What the code already gives us (reuse, don't rebuild)

| Existing | Used for |
|---|---|
| `payments` table + `payments.ts` (Cashfree create-order, server-side verify, HMAC webhook, mock mode, unique `gateway_payment_id`) | Gateway plumbing for per-order payment — generalised, not duplicated |
| `orders.payment_method` (`WALLET`/`COD`), `orders.paidAt`, `orders.taxPaise` (unused), `orders.acceptedAt`, `orders.checkoutKey` | Add `ONLINE` method; tax column already exists |
| `refundOriginalDebit` (wallet) + `refundDeliveredOrder` (finance, journaled) — COD refunds already land as wallet credit | Refund path for ONLINE orders (see §1.5) |
| `finance_ledger_entries` journal, commission snapshot on DELIVERED | New entries for gateway receipts / fees / invoices |
| `products.hsn_code`, `products.gst_rate_bp`, `shops.gstin`, `shops.gst_status` | Invoice tax inputs |
| `stored_images` + `/api/images` (validated uploads, safe fallback) | POD photo storage |
| `delivery_orders.delivery_otp`, `proof_note`, `deliveryConfirmation` | POD extends the existing handover, doesn't replace it |
| `notifications` framework, cron routes (`delivery-dispatch`, `notifications`), `exceptions` queue | SLA reminders, expiry sweep, ops visibility |

---

## 1. Direct payments (card / UPI / net-banking) — migration 0036

### 1.1 Model
New order payment method **`ONLINE`** (enum value added to `payment_method`; wallet and COD unchanged). One Cashfree hosted checkout
per order offers UPI, cards, net-banking and wallets; the app never sees card data (PCI scope stays with Cashfree).

`payments` is generalised, not forked:
- `purpose` enum gains `ORDER_PAYMENT` (today only `WALLET_TOPUP`).
- new `order_id uuid null references orders` (unique partial index where not null — one live payment per order attempt group).
- new `method_detail text null` (`UPI`/`CARD`/`NETBANKING`/… as reported by Cashfree — informational, from the verified response).
- new `fee_paise`/`tax_on_fee_paise bigint null` (gateway MDR if reported; for reconciliation only).
- new `expires_at timestamptz null`.

### 1.2 Flow (state machine)
```
checkout(paymentMethod=ONLINE)
  → order created status PENDING_PAYMENT?  NO — reuse PENDING (already: PENDING → CONFIRMED | PAYMENT_FAILED | CANCELLED)
  → stock reserved (same lock/consume as wallet path), payments row CREATED, Cashfree order created for the order total
  → customer pays in hosted checkout
  → server-side verify (Get Order API) and/or webhook  → payments PAID → order CONFIRMED, paidAt set (same function for both)
  → fail / abandon / expiry (default 15 min, tunable) → order PAYMENT_FAILED/CANCELLED, stock restored, no money moved
```
**Invariants (the review should attack these):**
1. An order becomes `CONFIRMED` only from verified gateway state, in one transaction with the payment status change; idempotent on
   `gateway_payment_id` AND on a `order:<orderId>` key — verify and webhook racing is a no-op for the loser.
2. Amount paid must equal the order total at verification time; mismatch → payment `PAID` recorded, order held `PAYMENT_REVIEW`
   (new status? — avoided: use a `payments.status = AMOUNT_MISMATCH` + exceptions-queue rule) and never auto-confirmed.
3. Late payment after expiry/cancel (customer pays on a stale checkout): payment is recorded, order stays cancelled, amount is
   **auto-credited to the customer's wallet** (idempotent key `late-payment:<paymentId>`) and flagged in the exceptions queue.
4. Stock reservation lifetime = payment window; a sweep (reuse `delivery-dispatch` cron or new `payment-expiry` cron) cancels expired
   unpaid ONLINE orders and restocks. Reservation uses the existing cancel path so audit/history rows stay uniform.
5. `PAID_STATUSES` (hand-maintained array — Opus-review finding D8) must be checked: no new order status is introduced, so it stays in sync;
   add a unit test assertion anyway.

### 1.3 Services / routes / UI
- `payments.ts`: `createOrderPayment(orderId, userId)`, generalise `verifyAndCreditTopUp` → shared `verifyGatewayPayment`, webhook
  branches on `purpose`.
- `orders.ts` `checkout`: accept `paymentMethod: "ONLINE"`; returns `{ orders, payment: { paymentSessionId, cashfreeMode, ... } }`.
  Multi-shop carts create one order per shop today → **one Cashfree order per shop order** (simpler refunds/settlement, per-shop invoices);
  UI pays them sequentially or groups them (design choice — recommended: group total into one Cashfree order, split `payments` rows
  proportionally is NOT done; keep one payment per order, pay sequentially with a "Pay now" action per order on the orders page).
- Routes: `POST /api/orders/{id}/pay` (re-create/resume session for a PENDING ONLINE order), extend `/api/webhooks/cashfree`.
- UI: payment-method selector in `cart-view.tsx` (Wallet / Online / COD with eligibility messaging), "Complete payment" banner on the
  orders page for PENDING ONLINE orders, return-from-gateway verify page.
- Rules (`platform_settings`, group `payments`): `online.enabled`, `online.expiryMinutes`, `online.maxOrderPaise`, `online.methods`
  (informational).

### 1.4 Finance
- Journal: `GATEWAY_RECEIPT` (debit gateway clearing, credit customer-funds liability) at PAID; existing commission/settlement logic
  then runs unchanged on DELIVERED because `paymentMethod` only affects *collection*, not shop payable.
- Reconciliation: extend the existing queue with "ONLINE payment PAID but order not CONFIRMED", "order CONFIRMED but payment not PAID",
  "amount mismatch". Daily Cashfree settlement-report import is **out of scope** (manual).

### 1.5 Refunds — **decision for the review**
Today every refund is a wallet credit, including COD. Options for ONLINE orders:
- **A (recommended for v1):** wallet credit (instant, identical code path, already journaled), with `wallet-terms` wording updated; add an
  admin "refund to source" marker on the payment for later.
- B: Cashfree Refund API to original source (UPI/card). Needs refund-status webhooks, partial-refund bookkeeping (substitution
  differences are small partials), and failure handling. Larger; do as a follow-up slice after A is QA'd.
Review question: is A acceptable under your wallet terms / RBI expectations? If not, B moves into this slice.

### 1.6 Out of scope
Saved cards/UPI mandates, EMI/BNPL, payment links, auto-reconciliation with Cashfree settlement files, surcharge/convenience fee.

---

## 2. Tax invoicing & billing tax fields — migration 0037

### 2.1 Model (shop invoices goods, platform invoices its own fees)
Prices are **tax-inclusive** (Indian MRP convention; the Product Master and `mrp` governance already assume it). Tax is therefore
*extracted*, never added: `tax = line_total × rate / (10000 + rate)` with integer-paise rounding (largest-remainder across lines so the
parts sum exactly to the invoice).

New tables:
- `tax_invoices` — `id`, `invoice_number` (unique, gapless per `(issuer_type, issuer_id, financial_year)` — see 2.3), `kind`
  (`TAX_INVOICE`/`BILL_OF_SUPPLY`/`CREDIT_NOTE`/`PLATFORM_FEE_INVOICE`), `order_id`, `issuer_type` (`SHOP`/`PLATFORM`), `issuer_shop_id`,
  `issuer_legal_name`, `issuer_gstin`, `issuer_state_code`, `buyer_name`, `buyer_gstin` (B2B only), `place_of_supply_state_code`,
  `supply_type` (`INTRA`/`INTER`), `taxable_value_paise`, `cgst/sgst/igst/cess_paise`, `total_paise`, `related_invoice_id` (credit
  notes), `issued_at`, `status` (`ISSUED`/`CANCELLED`), `snapshot jsonb` (full render data — invoices are immutable documents).
- `tax_invoice_lines` — `invoice_id`, `order_item_id`, `description`, `hsn_code`, `qty`, `unit`, `taxable_paise`, `gst_rate_bp`,
  `cgst/sgst/igst_paise`, `total_paise`.
- `invoice_counters` — `(issuer_key, financial_year, last_number)` row-locked increment → gapless sequence.

Additive columns: `orders.billing_state_code`, `orders.place_of_supply_state_code`, `orders.supply_type`,
`orders.tax_inclusive boolean default true`; `order_items.hsn_code`, `order_items.gst_rate_bp` (**snapshotted** at checkout like price);
`shops.state_code` (derived from GSTIN prefix when present, else address state); `platform_settings` group `tax`:
`platform.gstin`, `platform.legalName`, `platform.stateCode`, `platform.deliveryFeeGstRateBp` (18% default), `platform.feeSac`
(`9965` goods transport / `9985` support services — confirm with CA), `invoice.prefixShop`, `invoice.prefixPlatform`.

### 2.2 Rules
- **Unregistered shop** (`gst_status` ≠ verified or no GSTIN) → `BILL_OF_SUPPLY`, zero tax lines, wording per rule 49 (tunable text).
- **Intra-state** (shop state = delivery state): CGST+SGST split equally; **inter-state**: IGST. Place of supply = delivery address state
  (goods) — derived from PIN→state map (`pincode_state` lookup table; ship a seed, or reuse the geocoding result).
- Missing `hsn_code`/`gst_rate_bp` on a product: use a tunable default rate with an explicit `RATE_ASSUMED` flag on the line and an
  exceptions-queue item; never silently invent a rate.
- **Delivery fee** and platform commission are *not* on the shop invoice; platform issues `PLATFORM_FEE_INVOICE` for the delivery fee
  (18% GST, tax-inclusive) at DELIVERED. Commission invoicing to shops is a **settlement-time** document (out of scope, listed in §6).
- **Generation trigger:** goods invoice at **DELIVERED** (supply point) via the same transition hook that snapshots commission;
  idempotent per `(order, kind)`. Cancelled-before-delivery → no invoice. **Returns/refunds after delivery** → `CREDIT_NOTE` linked to the
  original, amount = refunded goods value, tax reversed pro rata, created inside `refundDeliveredOrder`'s transaction.
- Substitutions/removed lines are already reflected in `order_items` fulfilment state — invoice lines come from *delivered* lines only.
- B2B orders: buyer GSTIN from `buyer_shop`, invoice kind unchanged, `buyer_gstin` populated.

### 2.3 Numbering
`SHOPCODE/FY/000123` per issuer per financial year (April–March), generated under a row lock on `invoice_counters` inside the
generating transaction → gapless, no duplicates on retry (idempotency key makes retries return the existing invoice).

### 2.4 Output
- `GET /api/orders/{id}/invoices`, `GET /api/invoices/{id}` (JSON), `GET /api/invoices/{id}/pdf` — server-rendered HTML→print-ready page
  (`/orders/{id}/invoice/{invoiceId}` with print CSS) in v1; real PDF library is a follow-up (avoids a dependency decision).
- Visibility: customer (own), shop owner (own shop), operator/admin (all), nobody else. New permission `invoice:view-own`, `invoice:manage`.
- Shop finance screen gets an invoice list + monthly **GSTR-1-style CSV export** (B2B/B2C-large/B2C-small, HSN summary) — read-only helper,
  clearly labelled "assist, not a filing".

### 2.5 Out of scope
E-invoicing (IRN/QR via GSP) and e-way bills (thresholds not met for local delivery; add if turnover requires), TCS under §52
(marketplace collects 0.5% TCS on shop supplies — **flag to the CA; computed per settlement, not built here**), cess, composition-scheme
shops (treated as bill-of-supply).

---

## 3. Photo proof of delivery — migration 0038

### 3.1 Model
Extend, don't replace, the OTP handover. New `delivery_proofs` table: `id`, `delivery_order_id`, `kind` (`DELIVERY_PHOTO`/`RETURN_PICKUP_PHOTO`/`FAILED_ATTEMPT_PHOTO`),
`stored_image_id`, `captured_at`, `latitude`/`longitude`/`accuracy_m` (nullable — only if the rider granted location), `distance_to_drop_m`
(computed server-side vs the order's coordinates), `taken_by` (rider user), `created_at`. Photos reuse `stored_images` (existing validation,
size limits, safe fallback).

Rules (`platform_settings` group `proof`): `photo.required` (`NEVER`/`ALWAYS`/`ABOVE_AMOUNT`/`NO_OTP`), `photo.requiredAbovePaise`,
`photo.maxDistanceMeters` (soft flag, not a hard block), `photo.retentionDays` (default 180).

### 3.2 Flow
`deliver` today: customer OTP (or operator override with note). New: when the rule says a photo is required, `deliver` additionally requires
a `deliveryProofId` uploaded by that rider for that delivery; OTP-less handovers (customer unreachable → "left at gate" with society
gate-access) **require** a photo plus note. Failed delivery requires a photo of the attempt when the rule says so. Distance is recorded and, if
beyond the threshold, raises an exceptions-queue item (not a block — GPS is unreliable indoors).

### 3.3 Privacy & abuse
- Photos are visible to: the rider who took it, the customer of the order, the shop owner of the order, operations/admin. Never public;
  served through an authenticated route (`GET /api/delivery-proofs/{id}/image`), `Cache-Control: private`, EXIF stripped on upload.
- Purge job deletes images past retention (keeps the row + hash for audit). Customer-facing wording added to the privacy policy.
- Dispute tooling: proof appears on the order timeline for operations; disputes (`DISPUTED` status) show it first.

### 3.4 Surfaces
Rider app: capture step (camera input `capture="environment"`, client-side shrink reusing the Phase I image helper), upload progress and
retry offline-tolerantly; order detail shows the photo to customer/shop; ops order monitor shows proof status chip.

---

## 4. Shop accept timeout / SLA — migration 0039

### 4.1 Model
Additive columns: `orders.accept_by_at timestamptz` (set when the order enters `CONFIRMED`: `now + shop SLA`), `orders.accept_reminder_sent_at`,
`orders.auto_cancelled_reason`; `shops.accept_sla_override_minutes` (nullable). `shop_sla_events` (`shop_id`, `order_id`, `kind`
`REMINDER`/`MISSED`/`ACCEPTED_LATE`/`ACCEPTED_ON_TIME`, `created_at`) feeds a 30-day miss counter.

Rules (group `shopSla`): `accept.minutes` (default 5), `accept.reminderFraction` (0.5), `accept.autoCancel` (true),
`accept.missLimit30d` (3 → raises a risk flag/review item and an optional automatic `orders_paused`), `accept.businessHoursOnly` (true: the
clock only runs while the shop is open; an order placed while closed gets its window starting at next opening — reuses shop hours logic
already used by "closed now" validation).

### 4.2 Flow
- On `CONFIRMED` (wallet/COD/ONLINE-after-payment): stamp `accept_by_at` — **not** at PENDING for ONLINE orders (clock starts after payment).
- Cron `POST /api/cron/shop-sla` every minute: (a) send the reminder (in-app + email via the notification framework) once at half-time;
  (b) for expired, still-`CONFIRMED` orders call the **existing** `rejectOrder`-equivalent system path (a system actor, reason
  "Shop did not respond in time") → full refund + restock + customer notification + audit + `shop_sla_events MISSED`;
  (c) guard: only orders still `CONFIRMED` with `accept_by_at < now()` under a row lock/conditional UPDATE so a shop accepting at the same
  instant and the sweeper cannot both win (the loser sees 0 rows updated — design the conditional update first, side effects after).
- Acceptance after expiry is impossible (order already cancelled); accepting before expiry records `ACCEPTED_ON_TIME`.
- Held (suspended-shop) orders are excluded from the sweep (reuse `shop-suspension-guard`).
- ONLINE orders: refund is per §1.5.

### 4.3 Surfaces
Shop orders screen: countdown badge and "accept by" time; ops order monitor + exceptions queue: "approaching SLA" and "missed" views;
admin: `/admin/settings` exposes the group; shop dashboard shows 30-day miss rate.

---

## 5. Cross-cutting

- **Permissions:** `payment:online` (customer), `invoice:view-own`, `invoice:manage`, `delivery-proof:upload` (rider),
  `delivery-proof:view`; mapped in `permissions.ts` per RBAC matrix — new permissions default-deny.
- **Audit actions:** `payment.order_created/verified/failed/late_credited`, `invoice.issued/credit_noted`, `delivery.proof_uploaded`,
  `order.auto_cancelled_sla`, `shop.sla_missed`.
- **Notifications:** payment failed/expired, invoice available, late-payment wallet credit, SLA reminder (shop) / auto-cancel (shop + customer).
- **Crons to schedule on the host:** `payment-expiry` (1 min), `shop-sla` (1 min), `proof-retention` (daily).
- **Migrations:** 0036 (payments), 0037 (invoicing), 0038 (proofs), 0039 (SLA) — all additive; the only enum-adding migration is 0036 (`ONLINE`,
  `ORDER_PAYMENT`) and must run as its own statement batch (same caveat as 0030).
- **Config/env:** none new for the gateway (reuses Cashfree keys; staging stays on **sandbox**). Production go-live of ONLINE additionally
  needs live Cashfree keys and the webhook URL registered — flagged, not done by development.

## 6. Build order (each slice independently shippable behind its rule flag, all default OFF in production)
1. **Shop accept SLA** (smallest, no external dependency) — 0039.
2. **Photo proof of delivery** — 0038.
3. **Invoicing & tax** — 0037 (needs 1.5/D6 CA confirmation of SAC and rates before production enablement).
4. **Direct payments** — 0036 (largest; ships last so invoicing/SLA behaviours exist when ONLINE orders appear).
Each slice: migration → services → routes → UI → docs in `PHASE1_DEV_LOG` format → typecheck/lint only → handoff list.

## 7. Questions for the Opus review
1. §1.2 invariant 2/3: is `AMOUNT_MISMATCH` + wallet auto-credit-on-late-payment the right failure model, or should late payments be
   refunded to source immediately (forces option B)?
2. §1.2 multi-shop carts: one gateway order per shop order (chosen) vs one combined gateway order with allocation — settlement and
   refund simplicity vs checkout friction.
3. §1.5: wallet-credit refunds for online payments acceptable? 
4. §2.2: invoice at DELIVERED vs at CONFIRMED/dispatch; place-of-supply derivation from PIN; handling products with no HSN/rate.
5. §2.5: TCS (§52) and platform commission invoicing are deliberately excluded — confirm that is acceptable for go-live or move them in.
6. §3.2: should "photo required" ever hard-block on GPS distance, or stay a soft flag?
7. §4.2 business-hours-only clock: edge cases for shops with no configured hours.
