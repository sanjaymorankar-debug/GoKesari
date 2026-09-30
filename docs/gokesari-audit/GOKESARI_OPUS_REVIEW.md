# GoKesari — Final Opus 5 Review of the Audit / Gap Analysis / Roadmap

*Reviewed 2026-09-22 by Opus 5, over the Sonnet 5 output in this directory. This is an **independent adversarial check**, not a summary: every finding cited below was re-derived by opening the source myself, and the test claims were re-verified by running `typecheck`/`eslint` and by reading the raw vitest evidence. **No file under `src/`, `drizzle/`, `tests/` or any pre-existing doc was modified; git was not touched; no hosted database was contacted.** The only write this review made is this file.*

Companion documents reviewed: [EXISTING_ARCHITECTURE](./GOKESARI_EXISTING_ARCHITECTURE.md) · [TARGET_ARCHITECTURE](./GOKESARI_TARGET_ARCHITECTURE.md) · [AUDIT_FINDINGS](./GOKESARI_AUDIT_FINDINGS.md) · [GAP_ANALYSIS.xlsx](./GOKESARI_GAP_ANALYSIS.xlsx) · [IMPLEMENTATION_ROADMAP](./GOKESARI_IMPLEMENTATION_ROADMAP.md) · [DATABASE_CHANGE_PLAN](./GOKESARI_DATABASE_CHANGE_PLAN.md) · [API_CHANGE_PLAN](./GOKESARI_API_CHANGE_PLAN.md) · [TEST_PLAN](./GOKESARI_TEST_PLAN.md) · [DEPLOYMENT_PLAN](./GOKESARI_DEPLOYMENT_PLAN.md) · [BASELINE_TEST_REPORT.xlsx](./GOKESARI_BASELINE_TEST_REPORT.xlsx) · `evidence/`

---

## 1. Verdict

**Sound enough to start Phase 1 on — with three corrections landed first.** This is a genuinely good audit. Accuracy is the strongest thing about it: I spot-checked ten of the twelve findings against the cited `file:line` and **every single one was accurate as described** — no fabricated line numbers, no finding that evaporated on inspection, no claim that a test name was doing the work of a code read. The evidence directory backs the headline numbers. The "what was verified, and how" table in the architecture doc is honest about what was *not* verified (Playwright, cron, live credentials), which is rarer and more valuable than the parts that were.

Two structural weaknesses keep it from being ready as-is:

1. **The audit is stronger on *privileged*-actor defects than on *customer*-reachable ones.** Every one of the twelve findings requires either a concurrency race, a shop/operator/admin actor, or a dependency CVE. The one abuse path an ordinary signed-in customer can walk on purpose, today, for money — cancelling a dispatched order and keeping the goods — is not in the findings, not in the 70 gap rows, and not in D1–D9. That is **DEF-08** below, and it sits in the *same function* Phase 1's very first defect fix will edit.
2. **"Every schema change is additive" does not survive contact with Phase 7.** The roadmap, the target architecture (§6) and the database change plan (§2.2) all assert it, and roadmap §2 declares no critical stop conditions. But the existing unconditional unique index on `delivery_orders.order_id` makes the roadmap's own GAP-005 action ("add offer expiry + re-offer excluding prior rejecters") impossible additively, and it silently destroys assignment history today. That is **DEF-09** below, and it needs a user decision, not an implementation-time judgement call.

Three corrections before Phase 1 writes code, in order:

| # | Correction | Why it blocks Phase 1 specifically |
|---|---|---|
| **1** | Add **DEF-08** and a **cancellation-policy decision (D10)** | Phase 1's first defect fix (DEF-01) edits `cancelOrder`. Fixing restock there while leaving the policy hole bakes the abuse path in behind a passing test, and forces a *second* behaviour change to the same money path later. Fix the function once, with the policy known. |
| **2** | Add **DEF-09** and an **offer-history decision (D11)** | Phase 1's DEF-03 fix has to choose between the partial-unique-index option and the transaction-only option. That choice is only correct if the offer-history question is already answered — otherwise Phase 7 reopens `delivery_orders` non-additively. |
| **3** | Reconcile **Phase 1 vs Phase 2 ordering** | Roadmap §5 requires characterization tests *before* touching `EXISTING_WORKING`/`EXISTING_PARTIAL` features; the phase table puts the behaviour changes (Phase 1) ahead of the route-level test foundation (Phase 2) with "Depends on: —". One of the two has to move. |

**SEC-06** (below) is a fourth item I would want acknowledged before Phase 3 wires up shop suspension, but it does not block Phase 1.

---

## 2. Findings confirmed

Ten of twelve re-derived independently. These held up **exactly** as written — cited lines correct, claim neither overstated nor hollow.

| ID | Verified how | Verdict |
|---|---|---|
| **SEC-02** | `src/server/db/schema.ts:756-767` — `panNumber`, `governmentIdType/Number`, `bankAccountHolderName/Number`, `bankIfsc`, `drivingLicenceNumber` are all bare `text()`. Contrast confirmed: `shops` PAN goes through `lib/pan-crypto.ts` and reveal is `SHOP_PAN_REVEAL`-gated and audited (`gst-pan-verification.ts:377-391`). | **Confirmed.** Recommendation (expand-then-contract on new `*_encrypted` columns) is correct and additive. |
| **SEC-03** | `src/lib/env.ts:137-140` hard-codes the two addresses; `src/server/auth.ts:136-148` re-promotes to `ADMIN` inside the **`session` callback**, so on every session refresh, not just `createUser`. | **Confirmed.** One caveat worth adding — see §3.5. |
| **SEC-04** | `rate-limit.ts:76-80` — `forwarded?.split(",")[0]?.trim()`, first entry, unconditionally. Coverage re-counted myself: **9 route files** call `enforceRateLimit`, out of **95** `route.ts` files (120 exported handlers). `/api/vouchers/preview` confirmed to have none while calling `previewVoucher(code, …)`. | **Confirmed, numbers exact.** One route missing from its list — see §3.6 / SEC-07. |
| **SEC-05** | `next.config.ts` is the default empty config; no `headers()`, no `async headers`. | **Confirmed.** |
| **DEF-01** | `restockOnline` is defined at `catalogue.ts:1114` and referenced **only** from `tests/integration/product-master-inventory.test.ts:13,93,263` — zero production callers, reproduced independently. `cancelOrder` (`orders.ts:372-441`) imports nothing from inventory and writes no `inventory_movements` row. | **Confirmed.** But the recommendation as literally worded will not compile — see §3.1. |
| **DEF-02** | `ORDER_CONFIRMED/READY/OUT_FOR_DELIVERY/DELIVERED/CANCELLED` and `STOCK_LOW` appear at `notifications.ts:17-21,42` and **nowhere else** in `src/`. `notifyOpenStockAlerts` (`inventory-alerts.ts:123`) has zero callers. | **Confirmed.** |
| **DEF-03** | `assignNearestPartner` (`delivery-assignment.ts:51-146`) uses bare `db.*`, no `db.transaction()`, no `.for("update")`. Schema claim verified precisely: `schema.ts:1430-1435` has `uniqueIndex("delivery_orders_order_id_unique").on(t.orderId)` plus **non-unique** `delivery_orders_partner_idx` and `delivery_orders_status_idx`. Nothing constrains `(delivery_partner_id, status)`. | **Confirmed, including the schema detail.** The partial-index remedy interacts with DEF-09 — see §4. |
| **DEF-04** | `acceptDeliveryOffer`/`rejectDeliveryOffer` (`delivery-assignment.ts:190-239`) check `row.status !== "OFFERED"` from a prior `SELECT`, then `UPDATE … .where(eq(deliveryOrders.id, id))` with no status predicate. `markPickedUp`/`markDelivered` (`241-292`) each `UPDATE deliveryOrders` and then call `updateOrderStatus`, which opens its **own** `db.transaction()` (`orders.ts:317`). | **Confirmed — and understated. See §3.2.** |
| **DEF-05** | `delivery-feasibility.ts:84-91` excludes on `eq(deliveryOrders.status, "ACCEPTED")` only; `delivery-assignment.ts:42,61,84` uses `ACTIVE_ASSIGNMENT_STATUSES = ["OFFERED","ACCEPTED","PICKED_UP"]`. | **Confirmed.** An extra divergence in the same pair of functions — see §3.4. |
| **DEF-06** | `src/app/api/orders/[id]/status/route.ts:20-28` accepts `"CONFIRMED"` in the Zod enum; `orders.ts:47-49` allows `PENDING/WALLET_INSUFFICIENT/PAYMENT_FAILED → CONFIRMED`; `updateOrderStatus` (`orders.ts:311-365`) sets `status` and writes history but never reads `paidAt` and never sets it. | **Confirmed.** Priority is arguable — see §4. |
| **DEF-07** | `updateWalletSettings` (`wallet.ts:324-357`) stores the three fields; nothing in `src/` reads `autoRechargeEnabled` to act on it. | **Confirmed substantively;** one factual slip in the evidence sentence — see §3.3. |
| **SEC-01** | **Not independently re-verified.** I did not re-run `npm audit` (no value added over the recorded run, and the advisory text is the authoritative source). | **Accepted as reported, unverified by me.** Its own caveats ("may not apply directly", "narrows but does not necessarily eliminate") are appropriately hedged rather than overclaimed. |

Two things the audit gets right that are worth stating explicitly, because a reviewer skimming the findings list could mistake them for gaps:

- **The Cashfree webhook is genuinely well built.** `src/app/api/webhooks/cashfree/route.ts` reads the raw body *before* parsing, verifies HMAC over `timestamp + rawBody`, returns **503 rather than accepting** when `CASHFREE_SECRET_KEY` is absent, acts only on `PAYMENT_SUCCESS_WEBHOOK` + `payment_status === "SUCCESS"`, and returns non-2xx on processing failure so Cashfree retries. `verifyWebhookSignature` (`payments.ts:455-472`) length-checks then uses `crypto.timingSafeEqual`. No finding needed; the audit correctly raised none.
- **The dev mock-settlement endpoint is correctly fenced.** `src/app/api/dev/settle-topup/route.ts:24-26` 404s when `NODE_ENV === "production"` **or** `isPaymentGatewayLive()`, then still requires `WALLET_TOPUP_OWN` and rate-limits. Double-gated. A "free wallet credit in prod" finding here would have been wrong, and the audit rightly didn't make one.

---

## 3. Findings disputed or refined

### 3.1 DEF-01 — recommendation will not compile as written *(implementation caveat, not an accuracy error)*

The finding says: *"call `restockOnline` (or an equivalent restock write) **inside `cancelOrder`'s existing transaction**."*

`restockOnline` cannot be called that way. Its signature takes no db client and opens its **own** transaction:

```
catalogue.ts:1114   export async function restockOnline(
                      shopProductId: string, units: number, reason: string, actorId: string,
                    ): Promise<ShopProduct> {
catalogue.ts:1124     return db.transaction(async (tx) => {
```

Compare its mirror-image `consumeOnlineStock`, which *does* accept a client and is therefore composable — `orders.ts:251-257` passes `tx` into it as the 4th argument. So the DEF-01 fix is necessarily a **two-part** change: add an optional `client?: DbClient` parameter to `restockOnline` (following `consumeOnlineStock`'s established shape), *then* call it with `tx` from `cancelOrder`. Worth spelling out, because the naive reading produces a nested-transaction bug in the exact function that moves refund money, and the existing test at `product-master-inventory.test.ts:93` calls `restockOnline` with the current 4-arg signature, so the parameter must be appended and optional.

`inventory_movements.createdBy` is `actorId` in `restockOnline`; for a cancel the sensible actor is `actor.id` from `cancelOrder`, which may be the customer, the shop, or an admin. Fine, but it means the movement ledger will attribute customer-initiated restocks to the customer — worth a deliberate choice rather than an accident.

### 3.2 DEF-04 — understated severity, and missing a reassuring caveat

**Understated.** The finding frames the split-state risk as *"a crash or error between the two"* leaves `deliveryOrders.status = PICKED_UP` while `orders.status` is still `READY`. That makes it sound like an infrastructure-failure edge case. It is not — there is an ordinary, reachable, no-crash path:

1. An order is `OUT_FOR_DELIVERY`, rider holds it at `PICKED_UP`.
2. Anyone entitled cancels it — admin/operator, the shop, **or the customer themselves** (see DEF-08). `ALLOWED_TRANSITIONS.OUT_FOR_DELIVERY` includes `"CANCELLED"` (`orders.ts:53`), so this succeeds, and `cancelOrder` does **not** touch `delivery_orders` at all (`orders.ts` imports no delivery table).
3. The rider taps "Delivered". `markDelivered` (`delivery-assignment.ts:267-292`) **first** writes `deliveryOrders.status = DELIVERED`, **then** calls `updateOrderStatus(row.orderId, "DELIVERED", actor)`, which throws `invalidTransition` because `ALLOWED_TRANSITIONS.CANCELLED = ["REFUND_PENDING"]`.
4. Result: `delivery_orders` says `DELIVERED`, `orders` says `CANCELLED`/`REFUNDED`, and because the throw happens **before** line 280, `creditDeliveryEarnings` never runs. **The rider did the delivery and is not paid**, and nothing detects or repairs the disagreement.

That is a High, not a Medium — it involves rider compensation and needs no concurrency at all. The remedy the finding proposes (one transaction, or a reconciliation job) is still the right remedy; the *ordering* inside `markDelivered` is a second, cheaper mitigation worth noting (call `updateOrderStatus` first, so the guard fires before `delivery_orders` is mutated).

**Missing caveat (the good kind).** The finding warns that two concurrent `markDelivered` calls could both pass the check and both write, and a reader could reasonably infer a double-payout risk. There isn't one: `creditDeliveryEarnings` (`delivery-earnings.ts:104-145`) short-circuits on an existing row for the `deliveryOrderId`, and falls back to re-reading on `isUniqueViolation` — a unique constraint backs it. **Money is already safe here.** Saying so keeps the fix correctly scoped to state consistency instead of inviting a redesign of the earnings path.

### 3.3 DEF-07 — one factual slip in the evidence, substance unaffected

The finding states *"no screen surfaces the setting to a customer (`grep` across `src/app` and `src/components` finds zero references)"*. That is not accurate — `src/app/api/wallet/route.ts:35-37` returns all three fields (`autoRechargeEnabled`, `autoRechargeTriggerPaise`, `autoRechargeAmountPaise`) in the wallet GET response. The correct statement is: no **component** consumes them (`src/components/wallet-view.tsx` reads `lowBalanceThresholdPaise` only), and nothing anywhere acts on them. The conclusion — a stored setting that silently promises nothing — stands. Worth fixing so the evidence line survives its own re-check.

### 3.4 DEF-05 — there is a second divergence in the same pair of functions

DEF-05 correctly identifies the `busy` mismatch. It misses that the two eligibility queries also disagree on soft-deletion:

- `delivery-feasibility.ts:47-52` — `and(status = APPROVED, isOnline = true, isNull(deletedAt))`
- `delivery-assignment.ts:70-72` — `and(status = APPROVED, isOnline = true)` — **no `deletedAt` check**

So the *stricter* filter is on the advisory path and the *looser* one is on the path that actually dispatches a real delivery. **Currently unreachable** — I grepped `delivery-partners.ts` and nothing ever writes `deliveryPartners.deletedAt` (deactivation sets `status = "DEACTIVATED"` at `delivery-partners.ts:320`, not the timestamp). So this is latent, not live. But DEF-05's remedy ("extract the busy predicate once and use it from both call sites") should be widened to "extract the whole eligibility predicate once", or the fix leaves the more dangerous half of the divergence in place for whenever soft-delete does get wired.

### 3.5 SEC-03 — add the caveat that the self-heal is role-only

`auth.ts:136-148` restores `role`, not `status`. `getCurrentUser` (`guards.ts:25-36`) returns `null` when `session.user.status !== "ACTIVE"`, so a suspended permanent-bootstrap account stays locked out. That is the correct design and is worth recording in the finding: it bounds the blast radius (the mechanism cannot resurrect a *suspended* account, only a *demoted* one), and it tells whoever implements the remediation not to "fix" status handling at the same time.

### 3.6 SEC-04 — its route list omits the only unauthenticated amplifying endpoint

SEC-04 enumerates voucher preview, catalogue-search, price-template and the delivery-partner status routes. All are authenticated. The one route that is **unauthenticated, uncached and query-amplifying** isn't listed — see **SEC-07** below.

### 3.7 Architecture-doc accuracy: the stated authorization invariant is not true

`GOKESARI_EXISTING_ARCHITECTURE.md` §4 and `permissions.ts:8-11` both assert that capability and ownership are asked separately and **"Both must pass."** For the owner branch of `requireShopAccess` that is false — see **SEC-06**. This matters beyond pedantry: the architecture doc is what Phase 3 will be implemented against, and Phase 3 wires up shop suspension.

### 3.8 Minor internal inconsistency

`GOKESARI_EXISTING_ARCHITECTURE.md` §7 says *"837 pilot products are promoted on the test database"*; §9 of the same file and `GOKESARI_DATABASE_CHANGE_PLAN.md` §1 both say **1,179**. Both are sourced from prior-session notes rather than a live read (correctly flagged as such), but one of the two numbers is wrong. Reconcile or mark the figure as approximate.

---

## 4. Missed findings

Continuing the existing numbering. All four were derived by reading the cited lines in this review pass.

### DEF-08 — A customer can cancel a dispatched order and take a full automatic refund
**Severity: High.** *Customer-reachable, no privileged actor, no race, money-losing.*

`PATCH /api/orders/[id]/status` has a customer branch with **no capability check and no status restriction**:

```
src/app/api/orders/[id]/status/route.ts:44-50
  if (body.status === "CANCELLED") {
    const user = await requireUser();
    if (order.userId !== user.id) {
      await requireShopAccess(order.shopId, { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
    }
    return ok(await cancelOrder(id, user, body.note ?? "Cancelled"));
  }
```

When the order is the caller's own, the only gate is `requireUser()`. `cancelOrder` then permits it from any pre-terminal state, because `ALLOWED_TRANSITIONS` (`orders.ts:50-53`) includes `"CANCELLED"` for `CONFIRMED`, `PREPARING`, `READY` **and `OUT_FOR_DELIVERY`** — and refunds the full amount:

```
orders.ts:389   const wasPaid = PAID_STATUSES.includes(order.status) && order.paidAt != null;
orders.ts:409-436  if (wasPaid) { await refundOriginalDebit({ … idempotencyKey: `refund:order:${order.id}` … }); → status REFUNDED }
```

So a signed-in customer can let the rider reach the door, POST `{"status":"CANCELLED"}`, and receive **`totalPaise` back in full — subtotal *plus* `deliveryFeePaise`** (`orders.ts:216` folds the fee into `totalPaise`, and `refundOriginalDebit` reverses the whole original debit). Four things compound it:

1. **No cancellation window, no fee retention, no policy of any kind** — no time check, no status ceiling, nothing.
2. **The live delivery assignment is orphaned.** `orders.ts` never touches `delivery_orders`. The rider keeps an `ACCEPTED`/`PICKED_UP` row, is still counted "busy" by `ACTIVE_ASSIGNMENT_STATUSES`, and is therefore **excluded from new assignments indefinitely** — and their `markDelivered` then fails exactly as described in §3.2, unpaid.
3. **Stock is not returned** (DEF-01), so the shop loses the unit as well as the sale.
4. **`ORDER_CANCEL_OWN` is never enforced.** The permission is defined (`permissions.ts:49`) and granted to `CUSTOMER`/`OPERATOR` (`:185,:235`), but `grep` finds no `can()`/`requirePermission()` call against it anywhere. Cancellation authority is ambient to "is this row mine".

This is the single most consequential omission in the audit, because **Phase 1's first defect fix edits this exact function**. Fixing restock inside `cancelOrder` without deciding the policy means the abuse path is preserved behind a newly-passing test, and the eventual fix becomes a *second* behaviour change to a money path — precisely what the brief's "preserve what works, extend, never rewrite" rule is trying to avoid.

**Recommendation:** do not patch this silently — it is a **product** decision (see D10). Then, in one change to `cancelOrder`: enforce `ORDER_CANCEL_OWN`; cap the customer-initiated path at a decided status ceiling (`CONFIRMED`/`PREPARING` is the conventional answer, with anything later requiring shop or operator action); cancel or re-route any active `delivery_orders` row in the same transaction; and apply whatever fee/partial-refund rule D10 lands on. Needs a route-level test — `order-cancel-refund.test.ts` exercises the service, not this endpoint's authorization branch.

### SEC-06 — `requireShopAccess` grants on ownership alone, with no capability check and no shop-status check
**Severity: Medium.**

```
src/server/authz/guards.ts:83-101
  const shop = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),   // ← deletedAt only; status ignored
    columns: { id: true, ownerId: true },
  });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId === user.id) return { user, isPrivileged: false };   // ← returns before any can() call
  if (can(user.role, options.anyPermission)) return { user, isPrivileged: true };
```

The owner branch returns **before** any capability check. `options.anyPermission` is only ever consulted for non-owners. Two consequences:

1. **Role demotion does not revoke shop write access.** An admin using `USER_SET_ROLE` to move a misbehaving `SHOP_OWNER` back to `CUSTOMER` changes nothing about what they can do to their shop, because `shops.ownerId` is untouched. Across the **16 routes** that use this guard they retain: order-status transitions (`orders/[id]/status`), delivery assignment (`orders/[id]/assign`), shop-product writes (`shop-products/[id]`), Excel price uploads (`excel-uploads`, `excel-uploads/[id]/apply`), price requests, product creation, GST/PAN submission, catalogue search, price-template download.
2. **Shop suspension does not revoke it either.** `shops.status` is not read here. It *is* enforced on the buy side — `cart.ts:363` (`"This shop is not accepting orders."`) and `catalogue.ts:878,972` gate on `status = "APPROVED"` — which is what bounds this to Medium rather than High: a suspended shop cannot take new orders. But its owner keeps every write listed above.

This also makes the invariant in `permissions.ts:8-11` and architecture §4 ("Both must pass") untrue as documented, and it means **GAP-034 ("Suspend / reactivate shop", P1, `EXISTING_PLACEHOLDER`) is incomplete as scoped**: adding `POST /api/shops/[id]/suspend` gives operators a button that does not actually suspend the shop's write surface. Whoever implements GAP-034 needs to know that.

**Recommendation:** decide the intended semantics first (D12 below — it changes behaviour for existing users, so it is the brief's "ambiguous existing behaviour" condition, not an implementation detail). The minimal coherent form is: keep the ownership short-circuit but add an explicit owner-side capability parameter (`ownerPermission`) so demotion revokes, and refuse on `shops.status` in the set of states where writes should stop. Every change here needs the negative-RBAC tests the test plan §3.4 already mandates.

### DEF-09 — Reassignment destroys the prior assignment record; the same partner can be re-offered an order they just rejected
**Severity: Medium (live defect) / High (blocks Phase 7 and Phase 8 non-additively).**

`delivery_orders` is constrained to **one row per order, for the order's entire lifetime**:

```
schema.ts:1430-1435
  uniqueIndex("delivery_orders_order_id_unique").on(t.orderId),   // unconditional, not partial
```

`assignNearestPartner` therefore **updates in place** rather than inserting a new offer (`delivery-assignment.ts:117-126`), overwriting `deliveryPartnerId`, `status`, `offeredAt`, and blanking `acceptedAt`/`cancelledAt`/`cancellationReason`. Three consequences, all reachable today:

1. **Rider history is silently reattributed.** After partner P1 rejects and the order is reassigned to P2, the single row now carries `deliveryPartnerId = P2`. `listMyDeliveryHistory` (`delivery-assignment.ts:352-362`) filters by `deliveryPartnerId`, so **P1's rejected job vanishes from P1's own history and the order appears in P2's**. Only the audit log retains the truth.
2. **Reject/re-offer ping-pong.** After a reject, the row's status is `REJECTED` — not in `ACTIVE_ASSIGNMENT_STATUSES` — so P1 is once again "not busy" (`delivery-assignment.ts:81-87`) and, being nearest, is the natural pick again. `reassignOrder` (`149-176`) skips its cancel block for a non-active row and hands straight to `assignNearestPartner`, which re-offers the same order to the partner who just rejected it. Nothing remembers the rejection.
3. **The roadmap's own remedy is not additive.** GAP-005's Recommended Action says *"add offer expiry + re-offer excluding prior rejecters"*, and roadmap Phase 7 lists "offer expiry + re-offer". **There is nowhere to record who rejected what.** Delivering that requires either a new `delivery_offers` / `delivery_assignment_attempts` table (additive, but a real design decision), or **dropping/replacing `delivery_orders_order_id_unique`** on a table with live rows — which is not additive, and is the kind of change `DATABASE_CHANGE_PLAN` §5 itself calls out as needing reverse SQL written in advance. The change plan's §3 lists a *partial unique index on `delivery_partner_id`* for DEF-03 but has **no row at all** for offer history, so this is currently unplanned work sitting directly under a Phase-7 commitment.

The same gap removes the data source for **two of the eight scoring factors** the target architecture §4 assigns to Phase 8: "Reliability" (completed/rejected counts) and, partly, "Load Balance". Target architecture §4 says these *"need history that isn't tracked yet"* — correct, but it does not connect that to the schema constraint that prevents tracking it, nor flag the non-additive branch.

**Recommendation:** decide the shape now (D11), before DEF-03's fix commits to the partial-index route. A separate append-only `delivery_offers` table is almost certainly the right answer: it is genuinely additive, it makes DEF-03's "at most one active assignment per partner" a partial unique index over the *new* table rather than a retrofit onto `delivery_orders`, it gives Phase 7 its expiry/re-offer ledger and Phase 8 its reliability inputs, and it leaves `delivery_orders` as the current-state row it already is.

### SEC-07 — Unauthenticated, unthrottled, query-amplifying feasibility endpoint
**Severity: Low.**

`src/app/api/checkout/delivery-windows/route.ts` — `GET`, `export const dynamic = "force-dynamic"`, **no guard, no rate limit** (confirmed in the audit's own `evidence/routes.csv`: `guards=''`, `RateLimit=''`). Each call runs `getFeasibleDeliveryWindows`, which does one `shops` read, one full scan of online+approved `delivery_partners`, and then **one `delivery_orders` query per in-radius candidate** in a loop (`delivery-feasibility.ts:84-91`). So request cost scales with rider count, it is uncacheable by construction, and it needs no session.

It also discloses live rider-availability per shop to anonymous callers — thin, but it is competitive operational data.

`/api/catalogue` is likewise unauthenticated and `force-dynamic` with no caller-supplied limit on `listProducts`, though it is a flatter query. Both belong on SEC-04's list; the first is the one that actually amplifies.

**Recommendation:** add `enforceRateLimit(clientKey(request, "delivery-windows"), …)` — the existing helper already covers this shape — and fold the per-candidate loop into one `inArray` query while touching it. Low risk, additive.

---

## 5. Gap analysis / priority concerns

**Priority distribution** (verified from the workbook): P0 ×7, P1 ×26, P2 ×30, P3 ×7 across 70 rows. The shape is reasonable and the P0 set maps cleanly onto the findings as the findings doc claims.

**Are the P0 "Recommended Action" entries safe and additive, per the brief's preserve-and-extend rule?** Five of seven, yes. Two need correction:

| Row | Concern |
|---|---|
| **GAP-003** (DEF-01, restock on cancel) | Action is correct and additive in intent, but see §3.1 — `restockOnline` is not transaction-composable as written, so this is a signature change plus a call, not a one-line call. Also, doing it without D10 means editing `cancelOrder` twice. |
| **GAP-005** (delivery lifecycle) | **Not additive as scoped.** It bundles four separate changes of very different risk — transaction+locks (safe), status-guarded updates (safe), unify the busy rule (safe), **"add offer expiry + re-offer excluding prior rejecters"** (requires new schema or a non-additive index change — DEF-09). Split it: the three safe items are genuine P0; the re-offer item is Phase 7 work gated on D11 and should not ride along under a P0 label. |

**Priorities I would change:**

- **GAP-004 (DEF-06, unpaid order → `CONFIRMED`) is over-prioritised at P0.** It needs a privileged actor (shop staff, operator or admin — the customer branch of that route only accepts `CANCELLED`), and no money moves either way: because `updateOrderStatus` never sets `paidAt`, a later `cancelOrder` computes `wasPaid = PAID_STATUSES.includes(status) && order.paidAt != null` → **false**, so the system correctly refuses to refund an order nobody paid for. It is an insider data-hygiene problem that would pollute settlement, which is real but is P1, and it is partly pre-empted by D8 anyway (see §6).
- **DEF-08 is absent from P0 and belongs there** — customer-reachable, needs no privileged actor, loses real money and real stock on every use. On the audit's own severity scale it outranks four of the current P0 rows.
- **GAP-006 (route-level HTTP tests) and GAP-007 (confirm the cron fires) are correctly P0** and I would not touch them. GAP-006 in particular is the right instinct: the finding that a route-level bug (wrong permission check, wrong status code) would not be caught today is exactly what DEF-08 and SEC-06 are — both are *route-layer* authorization defects in a codebase whose 82 non-PMD routes have no HTTP-level tests. That correlation is itself evidence the audit's own P0 call was right.
- **GAP-034 (suspend/reactivate shop, P1)** should carry an explicit dependency note on SEC-06 — see §4.

**Nothing in P2/P3 is dangerously under-prioritised**, with one exception worth a note: **GAP-027 ("Refund, return and replacement requests", P2)** is where a reader would expect cancellation policy to live, and its gap text (*"Refunds exist only as the automatic result of cancelling"*) describes the mechanism without noticing that the mechanism is exploitable. Once DEF-08/D10 exist, GAP-027 should cross-reference them.

---

## 6. Roadmap / sequencing concerns

**Dependency order is mostly right, and right for the stated reasons.** Phase 7 after Phase 1's DEF fixes, Phase 8 (Society) before the scoring factors that need it, Phase 9 gated on D1+D6, Phase 10 putting consent/suppression/frequency caps *before* any send capability — these are all correct calls, and the last one is a notably good one.

Four problems:

### 6.1 Phase 1 before Phase 2 contradicts roadmap §5

The phase table puts **Phase 1 (behaviour changes to checkout/orders/delivery)** first, with Phase 2 (route-level regression tests, 82 untested routes) listed as **"Depends on: —"**. Roadmap §5 then says, of `EXISTING_WORKING`/`EXISTING_PARTIAL` features: *"write characterization tests **before** changing behaviour, as their own commit."* Phase 3 correctly cites "Phase 2's tests as the safety net." Phase 1 does not — yet Phase 1 modifies `cancelOrder`, `updateOrderStatus`, `assignNearestPartner`, `acceptDeliveryOffer`/`rejectDeliveryOffer` and the order-status route, all of which are `EXISTING_PARTIAL` and all of which have **service-level but no route-level** tests.

The findings doc partly mitigates this per-finding ("write a failing integration test reproducing today's behaviour first"), and `GOKESARI_TEST_PLAN` §5.3 says route tests for the money paths must come first — which is the *correct* instruction, but it contradicts the phase table it is supposed to serve. **Resolve it explicitly:** either renumber so the test foundation precedes the fixes, or carve out "Phase 1a — route-level characterization tests for checkout / order status / cancel / wallet / delivery assignment" and make Phase 1b depend on it. As written, the two documents disagree about the single most important discipline in the whole plan.

### 6.2 Roadmap §2's "no critical stop conditions triggered" is too confident

§2 checks the brief's stop conditions and reports two near-misses (SEC-01, the stale branch) — good practice, genuinely. But two conditions are arguably met and not surfaced:

- *"security vulnerability in EXISTING functionality"* — **DEF-08** is one, in existing, shipped, customer-facing functionality. **SEC-06** is a second. Both were missed rather than judged.
- *"major rewrite / data-loss risk"* — **DEF-09** requires either new tables or replacing a unique index on a populated table to deliver a Phase-7 commitment the roadmap has already made. That is not a rewrite, but it is squarely outside the "every schema change is additive" guarantee that §2's conclusion rests on.

I would rewrite §2 to say: stop conditions checked, **four** surfaced rather than silently passed (SEC-01, the branch, DEF-08/D10, DEF-09/D11). The instinct to report rather than proceed was right; the net was too small.

### 6.3 Decisions that should be added to D1–D9

| ID | Decision | Blocks | Why it is the user's call, not the implementer's |
|---|---|---|---|
| **D10** | **Cancellation policy.** Who may cancel at which status? Is there a time window? Is the delivery fee refunded? Is there a cancellation fee? What happens to a rider already dispatched — do they get paid, and who bears it? | DEF-08 fix, **Phase 1's DEF-01 fix** (same function), Phase 4, GAP-027, and D6 (cancellation fees are revenue and must exist in the settlement model from the start) | It is a commercial and customer-experience policy with money attached. Today's de-facto policy is "customer may cancel any time up to delivery, full refund including the fee, rider unpaid" — which is almost certainly not what the user intends, and nobody has ever stated it. |
| **D11** | **Offer / assignment history model.** New append-only `delivery_offers` table, or replace the unconditional unique index on `delivery_orders.order_id`? | DEF-03's remedy choice, DEF-09, Phase 7 (expiry + re-offer), Phase 8 (Reliability / Load Balance scoring) | One branch is additive; the other is a non-additive migration on a live table. That asymmetry is exactly what the brief wants surfaced, and DEF-03's Phase-1 fix forecloses it if taken first. |
| **D12** | **Shop-owner capability revocation semantics.** Should ownership alone keep granting shop writes, or should role demotion and shop suspension revoke them? | SEC-06, GAP-034 (suspend/reactivate), Phase 3 | Changes behaviour for existing shop owners — the brief's "ambiguous existing behaviour" stop condition. Also determines whether GAP-034 delivers a working control or a decorative one. |

### 6.4 D8 and the DEF-06 fix are coupled, and the roadmap treats them as independent

D8 asks whether to extend `order_status` additively (keeping `CONFIRMED` = paid) or add a separate fulfilment-status column. DEF-06's fix removes `CONFIRMED` from the status endpoint's accepted targets. If D8 lands on "extend the enum with `SHOP_PENDING`/`ACCEPTED`/`REJECTED`", that endpoint's allowed-target list is rewritten again in Phase 4 — so the Phase 1 fix is a temporary shape, not a final one. Harmless, but the roadmap should say so, because the API change plan §1 currently presents it as a settled behaviour change with *"no current test or documented flow relies on setting `CONFIRMED` through this route"* as its whole backward-compatibility argument. That claim is true today, and worth re-checking after D8.

### 6.5 Architecture coherence — where the target mapping holds, and where it doesn't

Assessed against the three things the brief singled out:

- **Society model — holds.** Modelling `societies` on `shops` (status enum, operator-gated verification, audited transitions), `society_workers` on the membership + immutable-history pair, and `SOCIETY_ADMIN` on how `DELIVERY_PARTNER` was added, is the right instinct and genuinely additive. One correction: target architecture §5 proposes *"an ownership guard modelled on `requireShopAccess`"* — do **not** copy it as-is, because SEC-06 shows it skips the capability check on the owner branch. Copying that shape into a brand-new role reproduces the defect in new code. Fix or parameterise `requireShopAccess` first (D12), then model on the fixed version.
- **Assignment-scoring engine — holds in shape, blocked in data.** Reading weights from a versioned single-active-row config table (the `delivery_earnings_config` pattern at `schema.ts:1441-1460`) and keeping the scoring function pure is exactly right, and correctly makes tuning a data change rather than a deploy. But Reliability and Load Balance have no data source, and §4 does not connect that to the schema constraint that prevents one (DEF-09/D11). The engine's *shape* is sound; its *inputs* need D11 answered first.
- **Order-state extension — holds.** Keeping `CONFIRMED` = paid, inserting `SHOP_PENDING`/`ACCEPTED`/`REJECTED` before `PREPARING`, and adding `RETURNED`/`DISPUTED`/`PARTIALLY_REFUNDED` as new terminals is genuinely additive: `ALLOWED_TRANSITIONS` (`orders.ts:46-58`) is a total map over `OrderStatus`, so new enum values force a compile error until every one has an entry — TypeScript makes the migration self-checking, which is a real advantage of the existing design. The `ALTER TYPE … ADD VALUE` two-step caveat in `DATABASE_CHANGE_PLAN` §4 is accurate and correctly flagged. **One gap:** `PAID_STATUSES` (`orders.ts:65-71`) is a hand-maintained `readonly OrderStatus[]`, **not** a total map — adding `SHOP_PENDING`/`ACCEPTED`/`RETURNED` will *not* produce a compile error there, and silently omitting them means `cancelOrder` computes `wasPaid = false` and **refuses to refund a paid order**. That is a money bug waiting in Phase 4. Call it out in D8's implementation notes: every new post-payment state must be added to `PAID_STATUSES`, and a test should assert the two lists stay in sync.

---

## 7. Test verification result

Run in `D:\Claude_development\bkesari`. **No database was contacted** — neither the ambient `.env` Neon URLs nor the local cluster; the local Postgres was never started, because the vitest claim was verifiable from the recorded evidence.

### `npm run typecheck` — clean, exit 0

```
> dairy-bakery@0.1.0 typecheck
> tsc --noEmit
[exited with code 0]
```

### `npx eslint src tests` — 0 errors, exit 0

```
D:\Claude_development\bkesari\src\app\api\shop-products\[id]\route.ts
  88:27  warning  '_online' is assigned a value but never used   @typescript-eslint/no-unused-vars
  89:28  warning  '_offline' is assigned a value but never used  @typescript-eslint/no-unused-vars

D:\Claude_development\bkesari\tests\integration\pmd-loader.test.ts
  39:53  warning  '_i' is defined but never used  @typescript-eslint/no-unused-vars

✖ 3 problems (0 errors, 3 warnings)
[exited with code 0]
```

Matches `GOKESARI_EXISTING_ARCHITECTURE.md` §10 exactly ("0 errors, 3 pre-existing unused-variable warnings"). Neither typecheck nor lint regressed, and nothing in the audit's own doc-writing disturbed them.

### vitest evidence — **claim verified, and the CRLF diagnosis independently confirmed**

From `evidence/vitest-baseline.json`:

```
numTotalTests       = 628      numTotalTestSuites  = 190
numPassedTests      = 626      numPassedTestSuites = 188
numFailedTests      = 2        numFailedTestSuites = 2
numPendingTests     = 0        numTodoTests        = 0
success             = false
```

628 / 626 / 2 — exactly as claimed. Both failures are in `tests/unit/pmd-docs.test.ts`:

- `DATA_DICTIONARY.md is up to date with the workbook model` (test line 18)
- `SOURCE_REGISTER.md is up to date with the source registry` (test line 22)

The second failure's own message is decisive on its face — `expected '# Source register\r\n\r\n> Generated …' to be '# Source register\n\n> Generated from…'`. I then confirmed the mechanism end to end rather than taking it on trust:

| Check | Result |
|---|---|
| `git ls-files --eol docs/product-master/{DATA_DICTIONARY,SOURCE_REGISTER}.md` | `i/lf  w/crlf  attr/` — **LF in the index, CRLF in the working tree** |
| `git config core.autocrlf` | `true` |
| `.gitattributes` | **absent** — nothing pins `eol=lf` |
| Byte counts on disk | `DATA_DICTIONARY.md`: 356 CRLF / 0 bare LF · `SOURCE_REGISTER.md`: 465 CRLF / 0 bare LF |
| Renderer output | `src/server/pmd/docs/render.ts:82,143` — `out.join("\n")…trimEnd() + "\n"`, i.e. pure LF |
| Test comparison | `readFileSync(…, "utf8")` raw (test line 14) vs the LF renderer → byte inequality on every line |

**Conclusion: the "Windows CRLF line-ending artifact in a doc-drift test" claim is accurate, and it is a checkout artifact, not committed CRLF.** The index holds LF, so CI on Linux checks out LF and these two tests pass there — consistent with the project's CI being green. The remedy the test plan already proposes (§5.4, a `.gitattributes` pinning `docs/**/*.md` to `eol=lf`) is the correct one; `GAP-013` tracks it at P2, which is right.

**What I did not verify:** I did not re-run the 628-test suite (not required, and it needs a Postgres cluster), did not run `npm run build`, did not re-run `npm audit` (SEC-01 stands as reported but unconfirmed by me), and did not install or run Playwright — the audit is already explicit that E2E was never run, which remains an open item per `TEST_PLAN` §5.1.

---

## 8. Summary of what to change before Phase 1

Ordered by what blocks what.

1. **Add DEF-08 to the findings and D10 (cancellation policy) to the decisions — before any code touches `cancelOrder`.** This is the one item I would treat as a hard gate: Phase 1's first defect fix edits that function, and fixing restock without the policy means editing the refund path twice and shipping the abuse window in between.
2. **Add DEF-09 and D11 (offer-history model) — before DEF-03's fix picks the partial-index route.** Split GAP-005: keep transaction+locks+guarded-updates+unified-busy-rule as P0; move "offer expiry + re-offer excluding prior rejecters" to Phase 7 behind D11.
3. **Reconcile Phase 1 vs Phase 2.** Either renumber, or add a Phase 1a of route-level characterization tests for checkout / order status / cancel / wallet / delivery assignment, which Phase 1b depends on. The roadmap's phase table and its own §5 currently contradict each other.
4. **Add SEC-06 and D12** (shop-owner capability revocation), and note GAP-034's dependency on it. Not a Phase 1 blocker; is a Phase 3 blocker. Also correct architecture §4 / `permissions.ts:8-11`, whose "Both must pass" invariant is not what the code does.
5. **Correct the four finding-text items:** DEF-01's recommendation (needs a `client` parameter on `restockOnline` — it opens its own transaction); DEF-04's severity to High plus the reassuring note that `creditDeliveryEarnings` is already idempotent; DEF-07's "zero references" sentence (`api/wallet/route.ts:35-37` returns the fields); DEF-05 widened to the whole eligibility predicate, not just the busy rule.
6. **Add SEC-07** to the findings and to SEC-04's route list. Low severity, cheap fix.
7. **Re-grade GAP-004 (DEF-06) to P1** and note its coupling to D8; add DEF-08 to P0 in its place.
8. **Add an implementation note to D8:** `PAID_STATUSES` (`orders.ts:65-71`) is not exhaustiveness-checked, unlike `ALLOWED_TRANSITIONS`. Every new post-payment state must be added to it, or `cancelOrder` will silently refuse to refund a paid order. Assert the two stay in sync in a test.
9. **Reconcile the 837-vs-1,179 promoted-product figure** between architecture §7, architecture §9 and database change plan §1.

With items 1–3 landed, this plan is a sound foundation to implement against.
