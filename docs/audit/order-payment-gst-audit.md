# Order, payment, GST, invoice and product-upload audit — 31 Oct 2026

Step 0 of the five-area brief. Read-only audit of `staging` at `b913cfb5`; no code
changed. "Works?" is judged from code and the tests that exist; nothing was run for
this audit. Paths are relative to the repository root.

Legend — **Exists:** Yes / Partial / No. **Fix planned:** phase number (see the end),
or "—" when nothing is needed, or "Decision" when the owner must choose first.

Many features below are built but **switched off by an admin rule** (default off).
Those are marked "Yes (off)": the gap is a switch-on decision, not code.

## Area 1 — Order management

Order states (`orderStatusEnum`, `src/server/db/schema.ts:189`): PENDING, CONFIRMED,
ACCEPTED, PREPARING, READY, ASSIGNED, PICKED_UP, OUT_FOR_DELIVERY, DELIVERED, FAILED,
RETURNED, CANCELLED, PAYMENT_FAILED, WALLET_INSUFFICIENT, REFUND_PENDING, REFUNDED,
DISPUTED. Transitions: `src/lib/state-machines.ts:29-63`, enforced in
`updateOrderStatus` (`src/server/services/orders.ts:923`) and `emitEvent`.

| Feature | Scenario | Exists? | Works? | Gap | Fix planned |
|---|---|---|---|---|---|
| State machine | One machine + audit trail (who/when/why) | Yes | Likely | `order_status_history` has actor + free-text note, no reason code; system actor is null. `cancelOrder` writes CANCELLED→REFUNDED directly (bypasses the machine, no event) — `orders.ts:1439-1449`; refund statuses also set directly in `payments/intents.ts:486`, `order-payments.ts:558` | P1: route through the machine, add reason codes + `SYSTEM` actor |
| Shop accept/reject | Reject with reason, buyer told, prepaid auto-refund | Yes | Likely | Reject is a shop cancel (shown as CANCELLED "Rejected by shop"); no REJECTED label in UI filters | P1: rejection reason codes, "Rejected" label |
| Shop timeout | No response → auto-reject + refund | Yes (off) | Partial | `shopAcceptance` rule off by default (30 min). Runs on the every-minute `timeout-sweep` cron — a timer, see Decision D1 | Decision D1 |
| Fulfilment | Accepted→Preparing→Ready→pickup / shop delivery / GoKesari rider | Yes (off) | Likely | `fulfilmentOptions` off → always GoKesari rider. No separate "Packing" state (PREPARING = packing) | Decision D2 (switch on) |
| Tracking | Out for delivery with live map | Yes | Likely | 5 s polling, not push; shop's own delivery person not tracked | P4 |
| Delivery OTP | Delivered via OTP → Completed | Yes | Likely | Completed = `completedAt` timestamp, status stays DELIVERED | — (label only) |
| Partial availability | Shop marks items unavailable → buyer approves or cancels → partial refund | Partial | Partial | Removed items auto-refunded with **no buyer approval**; only substitutions wait for the buyer (`fulfilment.ts:138-330`) | P1: "approve changed order / cancel" step with timeout |
| Split order | Parent + child sub-orders per shop | Partial (off) | Partial | `order_groups` holds only a shared ref (`parentOrders` off); no group view/cancel/refund; no split shipments within one shop | P3 |
| Partial delivery | Some items delivered, rest pending/cancelled/refunded | **No** | – | No per-line delivered state | P3 |
| Cancellation | Buyer before packing / after packing / shop / admin | Yes | Likely | Before packing allowed only until CONFIRMED by default; after-packing fee rule off | Decision D2 |
| Failed delivery | Reattempt / RTO | Partial | Partial | Reattempt is a manual status change that **skips the delivery OTP**; RETURNED is manual, no auto-refund | P1: reattempt flow with OTP; RTO → refund |
| Returns | Return/replacement, window per category | Partial | Likely | One global 48 h window; no per-category window, no non-returnable flag, no replacement | P3 |
| Disputes | Ticket to shop + support, tracked to closure | Yes | Likely | — | — |
| Rider | Reject / reassign | Yes | Partial | `reassignOrder` not atomic (`delivery-assignment.ts:669-711`); rider cannot drop after accept | P1: make atomic |
| Duplicate order | Warning | Yes | Likely | — | — |
| Shop wallet | Delivery charge + commission per order, reversed on cancel/refund | Partial (off) | Likely | Debited only at DELIVERED; on refund after delivery the **delivery charge is never reversed** (`shop-wallet.ts:368-530`) | P1 |
| Notifications | Buyer/shop/rider/admin on each change, real time | Partial | Likely | Real time via `emitEvent`. Silent: order.placed (to shop via event), REFUND_PENDING, REFUNDED, RETURNED, DISPUTED; shop not told of buyer cancel before accept; admin relies on exceptions queue | P1 |

## Area 2 — Payments, refunds and returns

Gateway chosen by `PAYMENT_GATEWAY` (`src/server/payments/gateway/registry.ts:23-69`):
SANDBOX (default, refused on gokesari.com), CASHFREE (complete, sandbox-tested),
HDFC (UAT, checklist open), RAZORPAY / PHONEPE (unverified scaffolds). No live keys
in the repo. `onlinePayments`, `refundChoice.originalMethodEnabled` and `payouts`
rules are all off by default.

| Feature | Scenario | Exists? | Works? | Gap | Fix planned |
|---|---|---|---|---|---|
| Methods | UPI, cards, net banking, wallets, COD via RBI-authorised PA | Partial | Wallet + COD yes; online via hosted page (sandbox) | **Wallets (Paytm etc.) not a method** (`gateway/types.ts:15`). No live gateway credentials. No card data stored (hosted page only) | P2 add WALLET method; **Ready — awaiting credentials** |
| Webhooks | Source of truth, signature, idempotency | Yes | Yes | HDFC uses Basic auth only (no body signature); Razorpay no timestamp window | P2 (Razorpay window) |
| States | Initiated/success/failed/pending; auto-reconcile | Yes | Yes | Reconcile is the 5-min `payments-reconcile` cron (polling the gateway) | — (see D1) |
| Failed but debited | RBI TAT, auto-reversal | Partial | Partial | Late capture is flagged only. **No auto-refund, no TAT clock (T+1 UPI / T+5 cards), no ₹100/day compensation tracking** | P2 |
| Refunds | Original source; COD → verified bank/UPI; full/partial; status visible | Partial (off) | Likely | Original-method refunds off → online refunds go to wallet. COD bank refund is a manual finance step. Return notices always say "back in your wallet" (`returns.ts:774,792`) | P2 fix wording; Decision D3 |
| E-Commerce Rules 2020 | Policy before checkout, grievance officer, complaint timelines, price breakup | Partial | Partial | **No policy link/acknowledgement at checkout** (footer only, `cart-view.tsx:519-595`). Taxes shown as one line, not split. Grievance officer phone/address are placeholders. Grievances get SLAs only with `ticketForGrievances` on | P2; officer details = owner input |
| TCS s.52 | Configurable rate on payouts | Yes (off) | Likely | Applied only on the automated payout cycle (off); rate `confirmed_by_ca=false` | Decision D3 |
| TDS s.194-O | Configurable rate on payouts | Yes (off) | Likely | Same as TCS | Decision D3 |
| Payout statement | Seller-wise | Yes (off) | Likely | Payout cycle only | — |
| Settlement cycle | Payout cycle | Yes (off) | Likely | API providers unverified; bank-file provider works | **Ready — awaiting credentials** (RazorpayX / Cashfree Payouts) |
| Reconciliation | Orders vs payments vs refunds vs payouts | Partial | Partial | Shop payout cycle lines not reconciled (`finance.ts:1408-1600`); no gateway settlement-file import; no single report | P2 |

## Area 3 — GST calculation

Rates and thresholds are in the database: `gst_rules`, `hsn_tax_rates` (dated, audited,
`/admin/gst-config`), product rates at `/admin/product-gst`. Hard-coded: the allowed-rate
list (`src/server/gst/product-rates.ts:23`), e-invoice retry delay
(`gst/einvoice.ts:155`), `GSP_PROVIDER=mock` only (`src/lib/env.ts:184`).

| Feature | Scenario | Exists? | Works? | Gap | Fix planned |
|---|---|---|---|---|---|
| Product tax data | HSN + rate + cess on every line; block or queue | Partial | Partial | **Checkout never blocked**; missing rate → default 0 % (`services/invoices.ts:243-257`). **Cess never applied** (columns exist; GSTR-1 `csamt:0`) | P1: admin queue + configurable block; apply cess |
| Place of supply | CGST+SGST intra / IGST inter | Yes | Yes | Unknown buyer state silently becomes intra-state | P1: flag "assumed" always |
| Inclusive/exclusive, rounding | MRP-inclusive vs exclusive; line rounding | Yes | Yes | — | — |
| Delivery & platform fees | GST on delivery charge and platform fee | Partial | Partial | Platform fees invoiced to shop with SAC. Customer delivery fee: no GST invoice to the customer | P1 (Decision D4: who is supplier of delivery) |
| Composition / PAN-only | Bill of Supply, no GST | Yes | **Bug** | Composition dealer's GSTIN dropped, prints "Not GST-registered" (`invoices.ts:168-170`); credit note has no bill-of-supply variant | P1 |
| Credit / debit notes | Credit note on return/partial refund; debit note on price increase | Partial | Partial | No debit notes on shop invoices; partial refund credit note spread by value, not tied to returned lines | P1 |
| Tests | Worked examples per slab, intra/inter | Partial | – | No unit test of `splitInclusive` per slab (0/5/12/18/28/40); no 40 % case | P1 |

## Area 4 — Invoice and GST portal sync

| Feature | Scenario | Exists? | Works? | Gap | Fix planned |
|---|---|---|---|---|---|
| Tax invoice | Per completed (sub-)order: GSTIN, sequential per seller per FY, HSN, split, POS, signature, PDF to buyer + seller | Mostly (off) | Likely | `invoicing.enabled=false` by default. Signature is text, not DSC | Decision D4 (switch on) |
| E-invoice | IRN + signed QR above threshold, GSP adapter | Partial | Mock only | **Only a mock GSP.** `turnoverThresholdPaise` stored but never compared. No IRN cancellation. GSP call made under a DB row lock | P3; **Ready — awaiting credentials** (GSP) |
| GSTR-1 / GSTR-8 | B2B, B2C, CDNR, HSN via GSP + JSON fallback; TCS for GSTR-8 | Partial | JSON/Excel export works | No GSP upload; `etin` (operator GSTIN) blank; cess 0 | P3; **Ready — awaiting credentials** |
| Sync status | Pending/Synced/Failed + error, backoff, manual re-push, admin dashboard | Partial | Partial | Accounting jobs: full backoff + retry. E-invoice: fixed 10 min, no backoff, no limit, **no admin e-invoice dashboard** | P3 |
| Reusable export | Tally / BillBook / Odoo | Yes | Yes | myBillBook and Vyapar file-only | — |

## Area 5 — Product list upload

Shipped 15 Oct (PR #179), 23/23 on staging, prod smoke 4/4 on 18 Oct. Screen:
`src/app/shop/product-import/page.tsx` → `src/components/product-import-panel.tsx`.

| Feature | Scenario | Exists? | Works? | Gap | Fix planned |
|---|---|---|---|---|---|
| Template | XLSX + CSV, samples, instructions, dropdowns | Partial | XLSX only | **No CSV template.** One sample row. No dropdown for GST %, category; no required-field marking (`product-import/workbooks.ts:94-106`) | P1 |
| Upload | Drag and drop | Yes | Yes | — | — |
| Preview validation | Price ≤ MRP, HSN, GST rate, required, duplicates | Partial | Partial | Price > MRP only caught at import; bad HSN/GST only warnings; GST not checked against real slabs; no required fields | P1 |
| Import + error report | Valid rows in, error report | Yes | Yes | No "errors only" report | P1 |
| Summary | Added / updated / skipped | Yes | Yes | — | — |
| Bulk re-upload | Price + stock by SKU | Yes | Yes | — | — |
| Large files | Async with progress | Yes | Yes (slow) | `after()` background, no job queue; ~95 s / 5,000 rows locally | — |
| Catalogue export | "Download my catalogue" → edit → re-upload | Partial | **No round trip** | Only the old price list (no SKU/MRP/stock/HSN/GST); its "Product ID" column is read as a barcode on re-upload | P1 |
| Product rules | Loose goods empty price; shop MRP change per shop | Partial | Partial | Importer always creates PACKAGED (`product-import.ts:940`), so loose goods cannot be created by upload. Shop MRP per shop: works | P1 |
| Tests | tests/qa | **No** | – | No tests/qa spec for bulk upload | P1 |

## Owner decisions needed

- **D1 — "no cron" vs timers.** Shop no-response timeout, rider offer expiry, payment
  reconcile and RBI TAT are by nature time-based; today they run on the every-minute
  `timeout-sweep` and 5-min `payments-reconcile` crons. Event-driven alone cannot fire
  "nobody did anything for 10 minutes". Proposal: keep every state change event-driven
  (it already is), and keep one deadline sweeper for timeouts only.
- **D2 — switch-ons.** `shopAcceptance`, `fulfilmentOptions`, `parentOrders`,
  `shopWallet`, `customerMayCancelUntil=PREPARING`: built, off by default. Turn on, on
  staging first?
- **D3 — money switch-ons.** Original-method refunds, automated payout cycle (TCS 0.5 %
  / TDS 0.1 % need CA confirmation), live gateway (Cashfree production or HDFC).
- **D4 — invoicing.** Turn `invoicing.enabled` on; who is the supplier of the
  customer delivery fee (shop or GoKesari) for GST.
- **Credentials:** live payment gateway, payout provider, GSP/IRP (e-invoice + GSTR-1
  upload). Until then these stay "Ready — awaiting credentials".
- **Grievance officer** phone and address (placeholders today).

## Build phases (proposed)

- **P1 — correctness gaps in existing flows** (no new integrations): order machine
  bypasses, reason codes, partial-availability approval, reattempt-with-OTP and RTO
  refund, atomic reassign, shop-wallet delivery-charge reversal, missing notifications;
  GST cess, missing-HSN queue/block, composition GSTIN bug, debit notes, per-slab unit
  tests; product upload: CSV template, GST dropdown, preview checks, catalogue export,
  errors-only report, loose goods.
- **P2 — payments compliance:** checkout policy acknowledgement and GST split,
  failed-but-debited auto-refund with RBI TAT tracking, WALLET method, refund wording,
  payout lines in reconciliation.
- **P3 — larger features:** split orders (parent/child, group view), partial delivery,
  per-category return window + replacement, e-invoice dashboard + backoff + threshold
  check, GSP adapter interface for GSTR-1 upload (mock until credentials).
- **P4 — tracking push** (SSE instead of polling), mobile app parity, releases.

Each phase is a separate PR into `staging`, tested on both DB layouts (CI `test-split`),
released to gokesari.com only one at a time and in an owner-approved window.
