# Shop prepaid wallet + OTP-confirmed delivery (October 2026)

Shops keep a prepaid wallet. When a delivery is confirmed with the customer's
code, the order is completed and GoKesari's **commission** and **delivery
charge** are debited from the shop's wallet in **one database transaction**,
as two ledger entries linked to the order, once only. A shop below the minimum
balance cannot accept new orders. Everything is behind rule **`shopWallet`**,
**off by default**; the delivery-code hardening is always on.

Built on the `staging` branch (the test site), on top of the event layer
(migration 0058, docs/event-driven-2026-10).

- Test checklist: [TEST_CHECKLIST.md](TEST_CHECKLIST.md)
- Test values: [test-settings.sql](test-settings.sql) — applied to the test database by the "Test database" workflow when it changes on `staging`
- Test credits: [test-wallet-credits.sql](test-wallet-credits.sql) — wallet credits for named test shops (Asmy Exports ₹1,000, QA Test Bakery A ₹500), applied the same way, each once
- Migration: `drizzle/0059_shop_wallet_delivery_otp.sql` · rollback: `scripts/rollback-0059.sql`

## 1. What existed before (inspection)

| Item | Before | Files |
|---|---|---|
| a. Shop wallet / prepaid balance / top-up / ledger | **Missing.** Only the *customer* wallet existed (`wallets`, `wallet_transactions`, Cashfree top-up). Shops were paid weekly by settlement with the commission **withheld** (`order_financials`, `shop_settlements`). | `services/wallet.ts`, `services/payments.ts`, `services/finance.ts` |
| b. Delivery OTP per order | **Exists, incomplete.** 4-digit code generated when the rider starts the drop, stored **in plain text** (`delivery_orders.delivery_otp`), not sent to the customer — only shown on My Orders. No resend, no expiry on use. | `services/delivery-assignment.ts` `startDelivery`, `app/orders/page.tsx` |
| c. Rider enters OTP, marks delivered | **Exists and works, with gaps.** `PATCH /api/delivery-orders/{id}` `deliver`; only the assigned rider (`loadOwnDeliveryOrder`); lock after `deliveryOtp.maxAttempts` (5). Gaps: attempt counter not atomic (concurrent wrong codes could pass the limit), no support ticket on lockout, a double submit answered with a confusing error. | `services/delivery-assignment.ts` `markDelivered`, `components/delivery-partner-dashboard.tsx` |
| d. Commission and delivery charge | **Commission exists and works** (`commission_rates`: default / shop type / shop; snapshot in `order_financials` at delivery). **Shop delivery charge missing** (`orders.delivery_fee_paise` is what the *customer* pays). | `services/finance.ts` |
| e. Notifications on status changes | **Exists and works** — event layer: every order status change notifies customer and shop at once (`emitEvent` + `catalog.ts`, outbox `notification_deliveries`). Rider not told the delivery was confirmed; shop not told any money detail. Email live; no SMS vendor. | `server/events/*`, `services/notifications.ts` |

## 2. What changed / what was added

### Database — migration 0059 (additive)

| Object | Purpose |
|---|---|
| `shop_wallets` (one per shop) | `balance_paise`, `low_balance_notified_at`. A trigger refuses any change of `balance_paise` that does not come from a ledger insert, and a non-zero starting balance. |
| `shop_wallet_transactions` | Immutable ledger: `type` (TOP_UP, COMMISSION, DELIVERY_CHARGE, MANUAL_CREDIT, MANUAL_DEBIT), `direction` (CREDIT/DEBIT), `amount_paise`, `balance_before_paise`, `balance_after_paise`, `order_id`, `payment_id`, `reason`, `idempotency_key` (unique), `created_by`, `created_at`, `seq`. An AFTER INSERT trigger checks the row against the locked wallet and applies it — **the only way the balance moves**. UPDATE/DELETE refused. Unique `(order_id, type)` for COMMISSION / DELIVERY_CHARGE = an order can be charged once. |
| `payments.shop_id`, purpose `SHOP_WALLET_TOPUP` | Shop recharge through the existing Cashfree flow (and webhook). |
| `order_financials.commission_collection`, `shop_delivery_charge_paise` | Whether the commission was withheld at settlement (`SETTLEMENT`, as before) or paid from the wallet (`SHOP_WALLET`); the delivery charge debited. |
| `delivery_orders.delivery_otp_hash`, `_sent_at`, `_resends`, `_used_at`, `_locked_at`, `_ticket_id` | Hashed code, resend limits, single use, lockout and its ticket. Plain-text codes of finished deliveries are cleared; a drop under way when 0059 is applied keeps its plain code until used (the column is dropped in a later release). |

### Server

| File | Change |
|---|---|
| `server/services/shop-wallet.ts` **(new)** | Ledger engine (row lock → idempotency → insert; mirrors `wallet.ts`), `chargeShopWalletForDeliveredOrder`, `assertShopMayAcceptOrders`, recharge credit, admin adjustment, low-balance alert (event-driven), views. |
| `server/services/delivery-otp.ts` **(new)** | Code generation, salted HMAC (same scheme as login OTPs, keyed on `AUTH_SECRET`), direct email to the customer (never queued/stored), customer resend with limits enforced in the UPDATE, atomic wrong-attempt counting, lockout → grievance ticket + event. |
| `server/services/delivery-assignment.ts` | `startDelivery` stores only the hash and emails the code; `markDelivered` checks the code via `delivery-otp.ts`, spends it in the same UPDATE that marks the drop delivered (only if it is still the checked code), returns the delivered row on a repeated submit; codes cleared on fail/cancel/operator confirm; rider views strip the hash and add `deliveryCodeLocked`; operator confirmation tells the rider too. |
| `server/services/orders.ts` | `updateOrderStatus`: CONFIRMED → ACCEPTED/PREPARING refused below the minimum balance (server-side); on DELIVERED, after the finance snapshot, the wallet is charged **in the same transaction** and the charge is passed to the order event. Cancel clears the delivery code. **Gap closed:** a plain status change to DELIVERED (e.g. the shop's "Mark delivered", `PATCH /api/orders/{id}/status`) is refused while a rider holds the order — before, a shop could complete a rider's order without the customer's code, leaving the rider's delivery stuck at PICKED_UP. |
| `components/shop-order-manager.tsx` | The shop's "Mark delivered" / "Handed to customer" buttons are hidden while a rider holds the order. |
| `server/services/finance.ts` | Snapshot records the collection mode (shop payable = goods when the wallet pays the commission); settlement and "not yet settled" withhold only commission still owed (`goods − shop payable`); delivery charge counted as platform delivery revenue; reconciliation counts shop-wallet recharges. |
| `server/services/payments.ts` | `createShopWalletTopUpOrder`, `verifyShopWalletTopUp`; the shared verify/webhook path credits the shop wallet for a shop recharge. |
| `server/config/rules.ts` | New rule `shopWallet`; `deliveryOtp` gains `resendCooldownSeconds`, `maxResends`. |
| `server/events/catalog.ts`, `notifications/types.ts`, `notifications/templates.ts`, `services/audit.ts` | Shop "order delivered — wallet charged" with amounts and new balance; rider "Delivery confirmed"; `delivery.code_locked` (customer, shop, support); `shop_wallet.topped_up / low_balance / adjusted`; delivery-code email; audit actions. |

### API

| Route | |
|---|---|
| `GET /api/shops/{id}/wallet` **(new)** | Owner or finance staff: balance, levels, ledger. |
| `POST /api/shops/{id}/wallet/topup`, `/verify` **(new)** | Owner only. Same gateway rules as the customer wallet. |
| `POST /api/shops/{id}/wallet/adjust` **(new)** | Admin (`WALLET_ADJUST`): manual credit/debit as a ledger entry. |
| `POST /api/orders/{id}/delivery-code` **(new)** | Order's own customer: new code, rate-limited. |
| `PATCH /api/delivery-orders/{id}` `deliver` | Unchanged contract; new errors documented in API.md. |

### UI

| Page / component | |
|---|---|
| `/shop/wallet` **(new)** — `app/shop/wallet/page.tsx`, `components/shop-wallet-topup.tsx` | Balance, minimum, commission %, delivery charge, recharge, full ledger (entry, order, reason, amount, balance after). "Wallet" in the shop menu. |
| `components/shop-wallet-banner.tsx` **(new)** on `/shop` and `/shop/orders` | "Recharge wallet to accept orders" / "running low". |
| `/admin/shop-wallets` **(new)** — `components/shop-wallet-adjust-form.tsx` | Every shop's balance, lowest first; manual credit/debit. |
| `/orders` — `components/delivery-code-panel.tsx` **(new)** | "Code emailed to a***@…", **Get a new code** (shown once), on-hold note when locked. The code is no longer read from the database. |
| Rider dashboard | "Delivery locked" instead of the code box after a lockout. |
| `/shop/finance` | A delivered order whose commission the wallet paid is labelled "(paid from wallet)"; its payable is the full goods value. |

## 3. Configuration

Agreed amounts (8 Oct 2026): **delivery charge ₹25, minimum balance ₹200,
low-balance reminder ₹300, commission 1%**. All stay configurable without a deploy.

| Setting | Where | Default / agreed |
|---|---|---|
| Commission rate | Admin → Finance → Commission (`commission_rates`, existing; platform default, per shop type, or per shop) | **1%** — set as the platform default by `test-settings.sql` on test; set it the same way on production (until a rate is set, commission is 0%) |
| Delivery charge | Admin → Business rules → `shopWallet.deliveryChargePaise` | **₹25** (2500) |
| Minimum balance to accept orders | `shopWallet.minBalancePaise` | **₹200** (20000) |
| Low-balance reminder | `shopWallet.lowBalanceThresholdPaise` (≥ minimum) | **₹300** (30000) — the owner is warned once a charge takes the balance below ₹300, before the ₹200 block |
| Recharge limits | `shopWallet.topupMinPaise` / `topupMaxPaise` | ₹100 / ₹50,000 |
| Switch | `shopWallet.enabled` | **off** |
| Wrong-code limit | `deliveryOtp.maxAttempts` (existing) | 5 |
| Resend limits | `deliveryOtp.resendCooldownSeconds` / `maxResends` | 60 s / 3 |

## 4. Migrating, deploying, rolling back

**On test:** merging this PR into `staging` runs the "Test database" workflow,
which backs up the test database and applies 0059 (it watches `drizzle/**`).
Nothing is charged until `test-settings.sql` is applied (or `shopWallet` is
switched on in Business rules). The same workflow applies it, after a backup,
whenever the file changes on `staging`, or by hand with Run workflow →
`shop-wallet-settings`. To migrate by hand instead: back up, then
`DATABASE_URL=<test db> npm run db:migrate`.

**Production (later): apply 0059 BEFORE deploying the code.** The new code
reads the new `delivery_orders` columns on every delivery screen — the same
kind of mismatch that took shop pages down in release #86 (migrations 0056/0057).
Order: back up → `npm run db:migrate` → deploy → verify. 0059 is additive, so
the old code keeps working on a migrated database.

**Rollback:** switch `shopWallet` off, deploy the previous build, then run
`scripts/rollback-0059.sql` and delete the 0059 row from
`drizzle.__drizzle_migrations`. The script refuses to run while any shop wallet
holds money, a shop recharge is open, or a wallet-paid commission is not yet
settled — settle those first (shops' prepaid money must be returned or carried
over outside the app). Drops under way with hashed codes are locked for the old
build so they are never confirmed without a code; operations confirm them.

## 5. Tests

`tests/integration/shop-wallet-delivery-otp.test.ts` (real PostgreSQL, 21
cases, run with the agreed amounts): correct code (and a pre-0059 plain code), wrong code, lockout + ticket + alerts, concurrent wrong
codes, resend limits and the old code dying, customer-only resend (route),
double submit (concurrent and repeated) charged once, the shop unable to
complete a rider-carried order, the database refusing a
second commission, wrong rider (service and route), no code/hash in rider
responses, low balance blocks acceptance (402) and recharge unblocks it,
low-balance alert once with the final balance, charging past zero, cancelled
order charges nothing, balance/ledger guards, admin adjust, wallet access.
Updated for hashed codes: `delivery-assignment`, `delivery-assignment-route`,
`event-layer`, `order-completion`, `business-limits` (new `deliveryOtp` defaults).

## 6. Assumptions (please confirm) and decisions needed

**Assumptions made**

1. **No double commission.** Shops were already paying commission by having it
   withheld from settlement. With the wallet on, the wallet pays it and
   settlement pays the goods in full. Orders delivered while the rule was off
   keep the old treatment.
2. **"Delivery charge" is a flat, configurable amount per order delivered by a
   GoKesari rider**, separate from the delivery fee the customer pays. Orders the
   shop delivers itself are charged commission only.
3. **A delivered order is always charged**, even past zero — the delivery has
   happened. The minimum balance stops *new* acceptances (CONFIRMED → ACCEPTED or
   straight to PREPARING); orders already accepted carry on. Customers can still
   place orders with a blocked shop (it can accept once it recharges, or the
   acceptance timeout cancels them if that rule is on).
4. **The code goes to the customer by email** (sent directly, never stored).
   No SMS vendor is chosen yet (decision D2); the customer can also get a fresh
   code shown once on My Orders. A code never expires by time — only when used,
   replaced, or the drop ends.
5. **Support ticket = a grievance** (`GRV-…`, category Order, linked to the order),
   the existing ticket the "Report a problem" flow uses, plus an in-app/email
   alert to operators and administrators. These system tickets appear in the
   grievance dashboard's counts.
6. **Refund after delivery** keeps the existing rule: the shop bears the refunded
   goods minus the commission on them, through its next settlement. The commission
   and delivery charge already debited from the wallet are not reversed
   automatically; an admin can credit the wallet (Shop wallets → Credit).

**Decisions needed from you**

1. ~~Amounts~~ — decided: ₹25 delivery charge, ₹200 minimum, ₹300 low-balance
   reminder, 1% commission.
2. Should a shop below the minimum also be hidden from customers / refuse checkout,
   rather than only being unable to accept?
3. Should the delivery charge vary (e.g. by distance, or equal the rider's
   earning for the trip) instead of a flat amount?
4. Should a full refund after delivery automatically credit back the commission
   (and/or the delivery charge) to the shop wallet?
5. SMS for the delivery code: which vendor (MSG91, Twilio…)? The email path stays
   either way.
6. Holding shop money in a prepaid wallet may need the same legal review as the
   customer wallet terms (`/legal/wallet-terms`) — a seller-terms clause at least.
