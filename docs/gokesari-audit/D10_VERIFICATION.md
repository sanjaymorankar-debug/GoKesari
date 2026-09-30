# D10 — Order cancellation policy: verification (2026-09-30)

Nothing below was assumed. Each row was checked against the code, the git
history and the tests. **Source of truth:** decision D10 as recorded in
[GOKESARI_AUDIT_FINDINGS.md](./GOKESARI_AUDIT_FINDINGS.md) (DEF-08) and the Slice 3/4
extension written into `cancelOrder`'s own comment
(`src/server/services/orders.ts`). No cancellation rule was invented.

## What was inspected

| Question | Answer | Evidence |
|---|---|---|
| Does the D10 implementation exist? | **Yes.** | `cancelOrder(..., { selfService })` in `orders.ts`: status gate, goods-only refund, delivery-assignment cancel, rider earning, restock. Route passes `selfService: isOwnOrder`. Introduced in commit `d7308a0` (2026-09-24). |
| Is Phase 1a (characterization tests) implemented? | **Yes, partly.** | Route-level tests exist for checkout, order status/cancel, wallet, delivery assignment (`tests/integration/*-route.test.ts`). The D10 cases covered were only CONFIRMED, PREPARING, OUT_FOR_DELIVERY and someone-else's-order. |
| Is Phase 1b (fixes) implemented? | **Yes, with two gaps found and fixed today** (below). | DEF-08 + DEF-01 in `cancelOrder`; DEF-04 delivery cancel in the same transaction; DEF-06 removed `CONFIRMED` from the status endpoint. |
| Do the tests cover the D10 scenarios? | **Not fully before today.** | Untested: ACCEPTED/READY/ASSIGNED blocked, PICKED_UP, shop cancellation at each stage, rider released on shop cancel, partial-refund + cancel, restock skipping removed lines, settlement exclusion, fee journaling. Now covered by `tests/integration/d10-cancellation-policy.test.ts`. |
| Is the code deployed? | **Merged to `main`; the running version could not be verified from here.** | `origin/main` (`7e711b6`, PR #19, 2026-09-30) contains `goodsOnlyRefund`, `selfService` and the D10 tests. Whether the live host is running that build, and has migrations 0017–0024 applied, must be confirmed on the host (see "Deployment check"). |

## Requirement table

| D10 requirement | Code status | Test status | Deployment status | Gap |
|---|---|---|---|---|
| `CONFIRMED`: customer may self-cancel, **full** refund (goods + delivery fee) | Implemented (`cancelOrder`) | Existing route test + new service test (refund, stock, no settlement, no rider pay) | On `main` | None |
| `PREPARING` / `READY`: customer **blocked**, shop/operator only | Implemented | Existing test for PREPARING; **new** tests for READY | On `main` | None |
| Slice 3/4 extension: `ACCEPTED` and `ASSIGNED` blocked like PREPARING/READY | Implemented | **New** tests (ACCEPTED, ASSIGNED — assignment left untouched) | On `main` | Extension is still "pending the user's confirmation" in the code comment — **business confirmation outstanding** |
| `OUT_FOR_DELIVERY`: customer may cancel, **goods-only** refund, delivery fee **kept** | Implemented | Existing route test + **new** service test incl. rider ledger | On `main` | None |
| Extension: `PICKED_UP` treated like `OUT_FOR_DELIVERY` | Implemented | **New** test | On `main` | Same pending confirmation as above |
| Rider still paid on a customer cancel after pickup | Implemented (`creditDeliveryEarnings` inside the cancel transaction) | Existing + **new** assertions on the earning row and `RIDER_EARNING` ledger lines | On `main` | None. Since Phase D the amount comes from the earnings engine; `riderEarnings.cancelledAfterPickupPayoutPercent` defaults to 100 so D10 is unchanged |
| Delivery fee kept on a dispatched cancel is **accounted for** | **Missing** — the wallet kept the fee but the platform ledger never recorded it, while the rider's earning was journaled as a platform cost | None | Not on `main` | **Fixed today:** `postRetainedDeliveryFee` journals a `DELIVERY_FEE` credit (idempotent). Test added. |
| Shop / operator cancellation unrestricted, full refund at every status | Implemented | Existing (CONFIRMED only) + **new** tests at CONFIRMED, PREPARING, ASSIGNED, PICKED_UP | On `main` | None |
| Cancel/route any active delivery assignment in the same transaction (closes DEF-04 split state) | Implemented | Existing (OUT_FOR_DELIVERY) + **new** (ASSIGNED → CANCELLED, no earning) | On `main` | None |
| Restock on every cancel (DEF-01), removed line not restocked | Implemented | **New** tests (full and partial-fulfilment) | On `main` | None |
| Partial refunds are not repeated by a later cancel | Implemented (`order.totalPaise` is what is still held) | **New** test | On `main` | None |
| Cancelled orders never enter a shop settlement | Implemented by design (`order_financials` is created only on delivery) | **New** assertions | On `main` | None |
| `ORDER_CANCEL_OWN` actually gates customer self-cancel (DEF-08 point 4) | **Missing** — the route used only `requireUser()` | None | Not on `main` | **Fixed today:** route requires the permission on the customer branch. No role that could legitimately cancel is excluded (customer, shop owner, delivery partner, operator, admin all hold it) |
| Cancellation window / any time limit | **Not part of D10** — D10 has no time window | n/a | n/a | Not added, deliberately |
| Charges beyond the retained delivery fee | **None by D10** ("No new fee is introduced") | n/a | n/a | Not added, deliberately |

## Fixes made in this phase

1. `PATCH /api/orders/{id}/status` — the customer branch now requires
   `ORDER_CANCEL_OWN` (`src/app/api/orders/[id]/status/route.ts`).
2. `cancelOrder` — when the refund is goods-only, the retained delivery fee is
   journaled to the platform ledger (`postRetainedDeliveryFee` in `finance.ts`,
   key `order:{id}:delivery-fee-retained`, idempotent).
3. Characterization tests: `tests/integration/d10-cancellation-policy.test.ts`
   (13 cases). **Written, type-checked, not yet run** (development phase — QA runs them).

## Still needs a business answer (not invented here)

* **D10 extension statuses.** `ACCEPTED`/`ASSIGNED` (customer blocked) and
  `PICKED_UP` (goods-only) are implemented exactly as the code comment records, but
  the comment says they await the user's confirmation. Confirm or correct.
* **D6 (settlement model).** The retained delivery fee is now journaled as platform
  revenue; how it is shared or reported in settlements is still D6's decision.

## Deployment check (to be done on the host — cannot be done from the repo)

1. Confirm the running build includes commit `d7308a0` or later (e.g. the deployed
   commit hash on Hostinger).
2. Confirm migrations `0017`–`0024` are applied on that database (the D10 code reads
   `orders.refunded_paise`, `delivery_orders` handover columns and the extended
   `order_status` enum).
3. This phase adds migrations `0025`–`0031` — apply them, in order, after `0024`.
