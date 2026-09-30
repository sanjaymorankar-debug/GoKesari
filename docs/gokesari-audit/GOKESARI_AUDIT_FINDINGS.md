# GoKesari — Audit Findings (Security & Defects)

*Audited 2026-09-22 (SEC-01…05, DEF-01…07) by Sonnet 5, then independently reviewed the same day by Opus 5 — see [GOKESARI_OPUS_REVIEW.md](./GOKESARI_OPUS_REVIEW.md). Every finding below was confirmed by reading the cited source lines directly — none is inferred from a description or a test name alone. Ten of the original twelve findings were re-derived and confirmed exactly as written by the Opus review; four items (SEC-06, SEC-07, DEF-08, DEF-09) were added by that review and are marked as such below, and several others were corrected or refined per its report. **Decision D10 (the cancellation policy DEF-08 needed) was resolved by the user on 2026-09-22 — see DEF-08 below for the final rule.** No fixes have been applied; this is the discovery/gap-analysis phase per the brief's §4 ("do not code yet"). Findings feed [GOKESARI_GAP_ANALYSIS.xlsx](./GOKESARI_GAP_ANALYSIS.xlsx) (as GAP-001…005 and GAP-071…074) and are sequenced in [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md).*

Severity scale: **Critical** (exploitable data loss/compromise or active data corruption) · **High** (real risk or user-facing defect, no active exploitation path found) · **Medium** · **Low**.

---

## Security

### SEC-01 — Critical Next.js dependency vulnerabilities
**Severity: Critical (patch available, not yet applied)**

`npm audit --omit=dev` (165 production packages scanned) reports:

| Package | Severity | Advisory | Installed | Fixed in |
|---|---|---|---|---|
| `next` | Critical | [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) — unauthenticated RCE on Windows-hosted servers | 16.3.1 | 16.3.5 (no major bump) |
| `next` | Critical | [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) — unauthenticated RCE in the image-optimization API when AVIF files are used | 16.3.1 | 16.3.5 |
| `sharp` (transitive) | High | libheif vulnerabilities ([GHSA-g89c-p67h-r497](https://github.com/advisories/GHSA-g89c-p67h-r497), [GHSA-2jg2-4ch7-h545](https://github.com/advisories/GHSA-2jg2-4ch7-h545)) | <0.35.4 | patched release available |
| `uuid` (via `exceljs`) | Moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — missing buffer bounds check in v3/v5/v6 | <11.1.1 | `exceljs` 3.4.0 pulls a fixed `uuid` (major bump) |

The app is deployed on Hostinger Linux Node hosting (not Windows), so the first advisory's stated vector may not apply directly — this needs confirmation from Next.js's own advisory text, not assumed safe. The app does not use `next/image` in any component (`grep` found zero usages), which narrows but does not necessarily eliminate exposure to the second advisory, since Next's built-in `/_next/image` route exists whenever image optimization isn't explicitly disabled in `next.config.ts` (it currently has no custom config at all).

**Recommendation:** bump `next` and `eslint-config-next` to a fixed 16.3.x release (no major-version change, per `npm audit`'s own `fixAvailable`) on a branch, run the full gate (typecheck, lint, 628 tests, build), and add an `overrides` entry pinning `uuid` to `^11.1.1`. Do this before any other code change, per the brief's own golden rule — it patches, not rewrites.

### SEC-02 — Delivery-partner KYC and bank details stored in plaintext
**Severity: High**

`delivery_partners.pan_number`, `government_id_number`, `bank_account_holder_name`, `bank_account_number`, `bank_ifsc`, and `driving_licence_number` are plain `text` columns (`schema.ts:756-767`), written verbatim from the registration form (`delivery-partners.ts:109-117`). This is inconsistent with the shop PAN, which is already encrypted at rest with AES-256-GCM and displayed only masked (`lib/pan-crypto.ts`, `gst-pan-verification.ts:368-391`, reveal is `ADMIN`-only and audited).

**Recommendation:** reuse the existing `pan-crypto.ts` helper (or a generalised version of it) for these columns via an additive migration (new encrypted columns, backfill, then drop the plaintext ones in a later release per the project's own expand-then-contract policy), mask in the admin review queue, and audit any full-value reveal the same way `revealPanForAdmin` already is.

### SEC-03 — Hard-coded personal admin emails, permanently self-healing to ADMIN
**Severity: Medium**

`src/lib/env.ts:137-158` hard-codes two personal Gmail addresses as `PERMANENT_BOOTSTRAP_ADMIN_EMAILS`. `src/server/auth.ts:139-148` re-promotes the matching user's **role** to `ADMIN` on **every session refresh**, not just first sign-in, and this cannot be revoked by an operational change (env var, admin UI) — only by editing and redeploying source.

*Bound confirmed by the Opus review:* the self-heal restores `role` only, not `status`. `getCurrentUser()` (`guards.ts:25-36`) still returns `null` for any account with `status !== "ACTIVE"`, so this mechanism cannot resurrect a *suspended* permanent-bootstrap account — it can only re-promote a *demoted* one. Worth knowing before remediating, so the fix doesn't also "correct" status handling that already works correctly.

**Recommendation:** move both addresses to the `BOOTSTRAP_ADMIN_EMAILS` environment variable on both hosts (confirm with the user before removing the source fallback, since it is presumably what lets them administer the app today) and remove the hard-coded list once confirmed working, matching the mechanism the deployment doc already describes for every other admin.

### SEC-04 — Rate-limiting gaps
**Severity: Medium**

`src/server/api/rate-limit.ts` is documented as a known limitation (in-memory fixed-window counter, one process only) and covers only 9 of 95 routes (Opus review recount: 9 route files call `enforceRateLimit` out of 95 `route.ts` files, 120 exported handlers — confirmed exact): payment create/verify, checkout, cron, and grievance submission/lookup. Sensitive-but-unlimited routes include the voucher-code preview endpoint (`POST /api/vouchers/preview`, no rate limit, lets an authenticated user probe voucher codes without limit), the shop catalogue-search and price-template-download endpoints, and every delivery-partner status/location-update route — see also **SEC-07** for the one unauthenticated route in this gap that also amplifies cost per request, which this list originally omitted. Separately, `clientKey()` (`rate-limit.ts:76-80`) takes the **first** `X-Forwarded-For` entry unconditionally — a client-supplied header — as the rate-limit identity, which is spoofable unless the deployment's reverse proxy is known to overwrite rather than append to that header (not verified here).

**Recommendation:** extend rate limiting to voucher preview and any authenticated-guessing-prone endpoint; confirm with the hosting provider (Hostinger) whether `X-Forwarded-For` is proxy-set or client-passable, and if the latter, derive the client key from a header the proxy is known to control. Move the store to Redis before any horizontal scaling, as the deployment doc already recommends.

### SEC-05 — No HTTP security headers or Content-Security-Policy
**Severity: Medium**

`next.config.ts` is the default empty config — no `headers()` function, so the app sends none of `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, or `X-Content-Type-Options`.

**Recommendation:** add a `headers()` block in `next.config.ts` with a CSP appropriate to the app's actual script/style/image origins (Google Maps, Google Fonts if used, Cashfree's checkout script) plus the standard hardening headers. Low implementation risk, additive, no behaviour change to existing routes.

### SEC-06 — `requireShopAccess` grants on ownership alone: no capability check and no shop-status check on the owner branch
**Severity: Medium** *(found by the Opus review, 2026-09-22)*

```
src/server/authz/guards.ts:83-101
  const shop = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),   // deletedAt only; status ignored
    columns: { id: true, ownerId: true },
  });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId === user.id) return { user, isPrivileged: false };   // returns before any can() call
  if (can(user.role, options.anyPermission)) return { user, isPrivileged: true };
```

The owner branch returns **before** any capability check — `options.anyPermission` is only ever consulted for non-owners. Two consequences, across the **16 routes** that use this guard (order-status transitions, delivery assignment, shop-product writes, Excel price uploads, price requests, product creation, GST/PAN submission, catalogue search, price-template download):

1. **Role demotion does not revoke shop write access.** An admin using `USER_SET_ROLE` to move a misbehaving `SHOP_OWNER` back to `CUSTOMER` changes nothing about what they can still do to their own shop, because `shops.ownerId` is untouched.
2. **Shop suspension does not revoke it either.** `shops.status` is never read by this guard. This is bounded to Medium rather than High because the *buy* side already enforces `status = APPROVED` separately (`cart.ts:363`, `catalogue.ts:878,972`) — a suspended shop cannot take new orders — but its owner keeps every write listed above.

This also makes the "capability and ownership are asked separately — both must pass" invariant stated in `permissions.ts:8-11` and [GOKESARI_EXISTING_ARCHITECTURE.md](./GOKESARI_EXISTING_ARCHITECTURE.md) §4 **not true** for the owner branch specifically, and it means the placeholder "suspend/reactivate shop" gap (GAP-034) would ship a control that looks like it works but doesn't, until this is fixed.

**Recommendation:** decide the intended semantics first — this changes behaviour for every existing shop owner, which is the brief's own "ambiguous existing behaviour, modification could cause breakage" stop condition, not a routine implementation detail (see decision **D12** in the roadmap). The minimal coherent fix once decided: keep the ownership short-circuit but add an explicit owner-side capability parameter (e.g. `ownerPermission`) so role demotion revokes, and refuse when `shops.status` is in the set of states where writes should stop. Needs negative-RBAC route tests (per the test plan) proving a demoted or suspended owner is actually blocked.

### SEC-07 — Unauthenticated, unthrottled, query-amplifying delivery-feasibility endpoint
**Severity: Low** *(found by the Opus review, 2026-09-22)*

`GET /api/checkout/delivery-windows` has no auth guard (by design — it's a pre-checkout preview) and no rate limit (confirmed in `evidence/routes.csv`: `Guards=''`, `RateLimit=''`). Each call runs `getFeasibleDeliveryWindows()`, which does one `shops` read, one full scan of online+approved `delivery_partners`, and then **one `delivery_orders` query per in-radius candidate in a loop** (`delivery-feasibility.ts:84-91`) — so request cost scales with rider count, the endpoint is uncacheable by construction, and it needs no session. It also discloses live rider-availability per shop to anonymous callers — thin, but real operational data. `GET /api/catalogue` is similarly unauthenticated and unlimited, though its query is flatter.

**Recommendation:** add `enforceRateLimit(clientKey(request, "delivery-windows"), …)` — the existing helper already covers this shape. Fold the per-candidate loop into one `inArray` query while touching the function (this pairs naturally with DEF-03/DEF-05's "unify the eligibility predicate" fix). Low risk, additive, cheap.

---

## What the audit got right (worth stating, so a skim doesn't mistake these for gaps)

*Added from the Opus review, 2026-09-22 — both were checked and correctly found to need no finding.*

- **The Cashfree webhook is genuinely well built.** `src/app/api/webhooks/cashfree/route.ts` reads the raw body *before* parsing, verifies HMAC over `timestamp + rawBody`, returns `503` rather than silently accepting when `CASHFREE_SECRET_KEY` is absent, acts only on `PAYMENT_SUCCESS_WEBHOOK` + `payment_status === "SUCCESS"`, and returns non-2xx on processing failure so Cashfree retries. `verifyWebhookSignature` (`payments.ts:455-472`) length-checks then uses `crypto.timingSafeEqual`.
- **The dev mock-settlement endpoint is correctly fenced.** `src/app/api/dev/settle-topup/route.ts:24-26` returns `404` when `NODE_ENV === "production"` **or** `isPaymentGatewayLive()`, and still requires `WALLET_TOPUP_OWN` plus a rate limit underneath that. Double-gated.

---

## Defects (correctness)

### DEF-01 — Cancelled or refunded paid orders never restock inventory
**Severity: High**

`cancelOrder()` (`orders.ts:372-441`) refunds the wallet but never calls `restockOnline()` (`catalogue.ts:1114`) or writes an `inventory_movements` row reversing the earlier consumption. `restockOnline` exists, is tested in isolation (`product-master-inventory.test.ts`), and has **no production caller anywhere** — confirmed by an exhaustive reachability scan of all 241 exported service functions. Every cancelled paid order therefore leaves the shop's `online_stock` permanently short by the cancelled quantity.

**Recommendation (corrected by the Opus review):** calling `restockOnline` "inside `cancelOrder`'s existing transaction" is not a one-line change — `restockOnline` opens its **own** `db.transaction()` and takes no db client, unlike its mirror `consumeOnlineStock`, which *does* accept a client and is composed that way from `orders.ts:251-257` (`consumeOnlineStock(l.shopProductId, l.quantityUnits, "Online order", tx, orderRow.id)`). The fix is two parts: (1) add an optional `client?: DbClient` parameter to `restockOnline`, matching `consumeOnlineStock`'s shape (the existing call at `product-master-inventory.test.ts:93` uses today's 4-arg form, so the new parameter must be optional and appended); (2) call it with `tx` from inside `cancelOrder`. Decide who `inventory_movements.createdBy` attributes to when the actor is the customer (see decision **D10**, which also governs whether this fix and the DEF-08 fix below should land as one change to `cancelOrder` rather than two). Write a failing integration test reproducing today's behaviour first, then the fix, per the brief's own regression-protection discipline.

### DEF-02 — Order and stock notifications are defined but never emitted
**Severity: High**

`NOTIFICATION_TYPES` (`notifications.ts:14-43`) defines `ORDER_CONFIRMED`, `ORDER_READY`, `ORDER_OUT_FOR_DELIVERY`, `ORDER_DELIVERED`, `ORDER_CANCELLED`, and `STOCK_LOW` — but a full-text search of `src/server` finds them referenced **only in this enum**, never passed to `notify()` from `orders.ts`, `delivery-assignment.ts`, or `inventory-alerts.ts`. Separately, `notifyOpenStockAlerts` (`inventory-alerts.ts:123`) is exported but has zero callers. There is also no "new order" notification type at all, so a shop only learns of an order by refreshing `/shop/orders`.

**Recommendation:** emit the existing order-lifecycle notification types at each transition in `updateOrderStatus`/`cancelOrder`; add a `SHOP_NEW_ORDER` type emitted from `checkout()`; wire `notifyOpenStockAlerts` into the existing alert-evaluation path. All in-app-channel only, no new transport needed — the console-stub EMAIL/SMS/PUSH channels are a separate, lower-priority gap (see the gap analysis, "real notification transports").

### DEF-03 — Delivery assignment can double-offer the same idle partner across two different orders
**Severity: High**

`assignNearestPartner()` (`delivery-assignment.ts:51-146`) is **not wrapped in a database transaction**. It selects the nearest online, approved, in-radius, not-currently-busy partner by reading `deliveryOrders` at that moment, then writes a new `OFFERED` row. Two `READY` orders assigned concurrently (a realistic case: two shops mark orders ready around the same time, or an operator clicks "reassign" while a shop's own click is in flight) can both read the same partner as idle before either write lands, and both succeed — `delivery_orders` has a unique index on `order_id`, not on `(delivery_partner_id, status)`, so nothing in the schema prevents one partner from holding two simultaneous `OFFERED` assignments on two different orders. This is exactly the "duplicate assignment" failure mode the brief's gig-engine section calls out to prevent.

**Recommendation:** wrap the read-candidates-then-write-offer sequence in one transaction with a row lock (or a partial unique index enforcing at most one active assignment per partner), re-checking busy status inside the lock.

### DEF-04 — Delivery accept/reject race and non-atomic pickup/deliver transitions
**Severity: High** *(re-graded from Medium by the Opus review — see below)*

`acceptDeliveryOffer`/`rejectDeliveryOffer` (`delivery-assignment.ts:190-239`) each do a separate `SELECT` (via `loadOwnDeliveryOrder`) to check `status === "OFFERED"`, then a separate `UPDATE` with **no `WHERE status = 'OFFERED'` guard** — a classic check-then-act race. Under the current one-partner-per-offer design this cannot yet let two *different* partners both accept the same job (only one partner is ever offered a given delivery), but it can let two concurrent calls from the same partner (a double-tap, or a client retry) both pass the check and both write, racing `acceptedAt`/`cancellationReason`. Separately, `markPickedUp` and `markDelivered` (`delivery-assignment.ts:241-292`) each update `deliveryOrders` and then call `updateOrderStatus` (a **second**, independent `db.transaction()`).

**Severity correction (Opus review):** the split-state risk is not just a crash-window edge case — it is reachable with **no concurrency and no failure at all**, via an ordinary sequence: (1) an order reaches `OUT_FOR_DELIVERY`, rider holds it at `PICKED_UP`; (2) anyone entitled to cancel does so — including the customer themselves (see **DEF-08**) — which `ALLOWED_TRANSITIONS.OUT_FOR_DELIVERY` permits, and `cancelOrder` never touches `delivery_orders` at all; (3) the rider then taps "Delivered" — `markDelivered` writes `deliveryOrders.status = DELIVERED` **first**, then calls `updateOrderStatus(..., "DELIVERED", ...)`, which throws `invalidTransition` because `CANCELLED`'s only allowed next state is `REFUND_PENDING`; (4) the throw happens *before* `creditDeliveryEarnings` runs — **the rider completed the delivery and is not paid**, and nothing detects or repairs the disagreement between the two tables. That is why this is High, not Medium: it costs a real person real money, on a path with no crash and no race required.

**Reassurance worth keeping in view while fixing this:** the audit's original wording could be read as implying a *double-payout* risk from two concurrent `markDelivered` calls. There isn't one — `creditDeliveryEarnings` (`delivery-earnings.ts:104-145`) short-circuits on an existing row for the `deliveryOrderId` and falls back to re-reading on a unique-constraint violation. Money is already safe there; the fix should stay scoped to state consistency (and, cheaply, reordering `markDelivered` to call `updateOrderStatus` first so its guard fires before `delivery_orders` is mutated), not a redesign of the earnings path.

**Recommendation:** make the accept/reject UPDATE conditional on the expected current status (`.where(and(eq(id, ...), eq(status, "OFFERED")))`, check the returned row count); fold the `deliveryOrders` and `orders` status writes for pickup/deliver into one transaction, or at minimum reorder `markDelivered` so the order-status guard runs first (or add a reconciliation job that detects and logs the split-state case, if a single transaction isn't practical because of module boundaries). This interacts with **DEF-08**'s fix — cancelling a dispatched order needs to cancel or re-route the `delivery_orders` row, which closes this particular reachable path at the source.

### DEF-05 — Delivery feasibility and delivery assignment disagree on what "busy" means
**Severity: Low**

`getFeasibleDeliveryWindows()` (`delivery-feasibility.ts:84-91`) excludes a partner only if they have an assignment with status **`ACCEPTED`**. `assignNearestPartner()` (`delivery-assignment.ts:42,61,87`) excludes a partner with status `OFFERED`, `ACCEPTED`, **or** `PICKED_UP`. A partner who has been offered a job but not yet accepted, or who has already picked one up, can therefore be shown as "available" in the checkout-time feasibility preview while being ineligible for actual assignment moments later — an inconsistency, not a data-integrity risk.

**A second divergence in the same pair of functions (found by the Opus review):** the two eligibility queries also disagree on soft-deletion. `delivery-feasibility.ts:47-52` filters `isNull(deletedAt)`; `delivery-assignment.ts:70-72` does not check `deletedAt` at all. The *stricter* filter is on the advisory (feasibility-preview) path, and the *looser* one is on the path that actually dispatches a real delivery — the wrong way round if it ever matters. It is currently **latent, not live**: nothing in `delivery-partners.ts` ever writes `deliveryPartners.deletedAt` today (deactivation sets `status = "DEACTIVATED"` instead, at `delivery-partners.ts:320`), so this can't yet be triggered — but it will start mattering the moment soft-delete is wired up for partners, and the fix should account for it now rather than leave the more dangerous half of the divergence in place.

**Recommendation:** don't just extract the "busy" predicate — extract the **whole eligibility predicate** (busy rule *and* soft-delete check) once, and use it from both call sites. The `ACTIVE_ASSIGNMENT_STATUSES` constant already in `delivery-assignment.ts` is the right home for the first half; add the `deletedAt` check to it as well.

### DEF-06 — An unpaid order can be marked CONFIRMED through the status endpoint
**Severity: Medium** *(Opus review: real, but re-prioritised in the gap analysis — see below)*

`PATCH /api/orders/[id]/status` (`app/api/orders/[id]/status/route.ts`) accepts `CONFIRMED` as a target status for any shop staff or operator/admin holding `ORDER_UPDATE_STATUS_ANY`/`_SHOP`, and the state machine (`orders.ts:46-49`) allows `PENDING → CONFIRMED`, `WALLET_INSUFFICIENT → CONFIRMED`, and `PAYMENT_FAILED → CONFIRMED` with **no check that a payment actually happened** — the legitimate "retry after top-up" path for subscriptions goes through a different function (`retryFailedDelivery`) that re-attempts the wallet debit first; this generic endpoint does not. A shop owner or operator can therefore move an order that was never paid into a status that looks paid, with no `paidAt` set and no wallet transaction behind it.

**Priority note (Opus review):** this needs a *privileged* actor — the customer branch of this same route only ever accepts `CANCELLED` — and no money actually moves either way: because `updateOrderStatus` never sets `paidAt`, a later `cancelOrder` computes `wasPaid = PAID_STATUSES.includes(status) && order.paidAt != null` → `false`, so the system correctly refuses to refund an order nobody paid for. It's a real settlement-data-hygiene risk (an order that looks paid when it isn't), but it's P1, not P0 — re-graded accordingly in the gap analysis (GAP-004). It is also coupled to decision **D8**: if D8 extends `order_status` with `SHOP_PENDING`/`ACCEPTED`/`REJECTED`, this endpoint's allowed-target list gets rewritten again in Phase 4, so whatever fix lands here first is a temporary shape, not a final one.

**Recommendation:** either remove `CONFIRMED` from this endpoint's accepted target list (since the legitimate paths to `CONFIRMED` — checkout and the subscription retry — already go through dedicated, payment-checked functions) or add an explicit `paidAt`/wallet-transaction check before allowing the transition. Needs a regression test either way, since `checkout.test.ts` and `order-cancel-refund.test.ts` don't currently exercise this endpoint directly.

### DEF-07 — Wallet auto-recharge settings do nothing
**Severity: Low**

`updateWalletSettings()` (`wallet.ts:324-350`) validates and stores `autoRechargeEnabled`/`autoRechargeTriggerPaise`/`autoRechargeAmountPaise` — but nothing in the codebase ever reads these fields to trigger a recharge. *(Correction from the Opus review: `GET /api/wallet/route.ts:35-37` **does** return all three fields in the wallet response, so the original "zero references" claim was inaccurate. The substantive point stands — no **component** consumes them, `wallet-view.tsx` reads only `lowBalanceThresholdPaise` — but the API already surfaces a setting that, if a caller sets it via the API today, silently does nothing.)*

**Recommendation:** either implement the trigger (checking balance against `autoRechargeTriggerPaise` at debit time and creating a top-up payment order — this needs a saved payment method / mandate, which Cashfree's current integration doesn't have) or remove the setting until it can be delivered, so nothing in the product silently promises behaviour that isn't there.

### DEF-08 — A customer can cancel a dispatched order and take a full automatic refund
**Severity: High** *(found by the Opus review, 2026-09-22 — the single most consequential item added to this audit)*

Every one of the twelve original findings needed a privileged actor, a race, or a dependency CVE. This one needs none of those — it is reachable by any signed-in customer, on purpose, today, for money.

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

When the order is the caller's own, the **only** gate is `requireUser()` — no capability check, no status ceiling. `ALLOWED_TRANSITIONS` (`orders.ts:50-53`) permits `CANCELLED` from `CONFIRMED`, `PREPARING`, `READY`, **and `OUT_FOR_DELIVERY`** — i.e. even after a rider has physically picked up the order — and `cancelOrder` refunds the **full** `totalPaise` (subtotal *plus* `deliveryFeePaise`, per `orders.ts:216` and `refundOriginalDebit` reversing the whole original debit) via `orders.ts:389,409-436`. Four things compound it:

1. **No cancellation window, no fee retention, no policy of any kind** — no time check, no status ceiling, nothing.
2. **The live delivery assignment is orphaned.** `cancelOrder` never touches `delivery_orders`. The rider keeps an `ACCEPTED`/`PICKED_UP` row, stays counted "busy" by `ACTIVE_ASSIGNMENT_STATUSES`, and is therefore excluded from new assignments indefinitely — and their subsequent `markDelivered` then fails exactly as described in **DEF-04**'s severity correction above: unpaid, for a delivery they actually completed.
3. **Stock is not returned** (DEF-01), so the shop loses the unit as well as the sale.
4. **`ORDER_CANCEL_OWN` is never enforced.** The permission is defined (`permissions.ts:49`) and granted to `CUSTOMER`/`OPERATOR` (`:185,:235`), but no `can()`/`requirePermission()` call against it exists anywhere in the codebase — cancellation authority today is ambient to "is this row mine," not to holding the permission that supposedly gates it.

**Why this is urgent specifically for Phase 1, not just important generally:** Phase 1's first defect fix (DEF-01) edits `cancelOrder` — the exact same function. Fixing restock there without deciding the cancellation policy first bakes the abuse path in behind a newly-passing test, and forces a *second* behaviour change to the same money-moving function later — precisely what the brief's "preserve what works, extend, never rewrite" rule exists to prevent.

**Decision D10 — RESOLVED by the user, 2026-09-22:**

| Order status | Customer may self-cancel? | Refund | Rider |
|---|---|---|---|
| `CONFIRMED` (paid, shop hasn't started) | Yes | Full (`totalPaise` — subtotal + delivery fee + tax) | n/a, not yet assigned |
| `PREPARING` / `READY` (shop is actively picking/packing) | **No** — only shop/operator/support can cancel here | Same as today (full, since only staff-initiated) | n/a or not yet dispatched |
| `OUT_FOR_DELIVERY` (rider has it) | **Yes, again** | **Goods only** — `subtotalPaise` refunded, `deliveryFeePaise` (and `taxPaise`, currently always 0) **kept** | **Still paid** their delivery earnings regardless — the withheld delivery fee is what makes this affordable, and the rider isn't penalised for a cancellation that isn't their doing |

No new fee is introduced — the policy works entirely with the amounts an order already carries (`subtotalPaise`, `deliveryFeePaise`); it just changes which of them get refunded, and at which status the customer-initiated path is available at all. Shop/operator-initiated cancellation is unaffected by any of this — it keeps today's behaviour (full refund) at every status; only the *customer's own* cancel path gets the new status gate and the reduced refund at the dispatched stage.

**Recommendation:** in one change to `cancelOrder` (and the route that calls it): enforce `ORDER_CANCEL_OWN` on the customer branch; when the actor is the order's own customer (not shop/operator), reject `CANCELLED` from `PREPARING`/`READY` with a clear "contact the shop" message, but allow it from `CONFIRMED` and `OUT_FOR_DELIVERY`; compute the refund amount from the table above based on the status at the moment of cancellation; cancel or re-route any active `delivery_orders` row in the same transaction (this also closes DEF-04's reachable split-state path at the source, and still lets `creditDeliveryEarnings` run for the rider per the table). Needs route-level tests for all three branches (full refund, blocked, goods-only) — `order-cancel-refund.test.ts` exercises the service's happy path, not this endpoint's own authorization branch or the new status gate.

### DEF-09 — Reassignment destroys the prior delivery-offer record; the same partner can be re-offered a job they just rejected
**Severity: Medium (live today) / High (blocks Phase 7 and Phase 8 non-additively)** *(found by the Opus review, 2026-09-22)*

`delivery_orders` is constrained to **one row per order, for the order's entire lifetime**:

```
schema.ts:1430-1435
  uniqueIndex("delivery_orders_order_id_unique").on(t.orderId),   // unconditional, not partial
```

`assignNearestPartner` therefore **updates the existing row in place** on reassignment (`delivery-assignment.ts:117-126`) rather than inserting a new offer — overwriting `deliveryPartnerId`, `status`, `offeredAt`, and blanking `acceptedAt`/`cancelledAt`/`cancellationReason`. Three consequences, all reachable today:

1. **Rider history is silently reattributed.** After partner P1 rejects and the order is reassigned to P2, the single row now carries `deliveryPartnerId = P2`. `listMyDeliveryHistory` filters by `deliveryPartnerId`, so **P1's rejected job vanishes from P1's own history and appears in P2's instead.** Only the audit log retains the truth.
2. **Reject/re-offer ping-pong.** After a reject, the row's status is `REJECTED` — not in `ACTIVE_ASSIGNMENT_STATUSES` — so P1 is once again "not busy" and, being nearest, is the natural pick again. `reassignOrder` skips its cancel block for a non-active row and hands straight to `assignNearestPartner`, which re-offers the same order to the partner who just rejected it. Nothing remembers the rejection.
3. **The roadmap's own planned remedy is not additive as scoped.** The delivery-lifecycle gap's original recommendation included "add offer expiry + re-offer excluding prior rejecters" — but **there is nowhere to record who rejected what.** Delivering that needs either a new `delivery_offers` table (additive, a real design decision) or dropping/replacing `delivery_orders_order_id_unique` on a table that will hold live rows by then (not additive). This finding has been split out of that item (now GAP-005/GAP-072 in the gap analysis) so the genuinely-safe P0 work isn't blocked on it.

This also removes the data source for two of the eight factors the target architecture's assignment-scoring design (§4) assigns to Phase 8: **Reliability** (completed/rejected counts) and, partly, **Load Balance** — the target architecture correctly notes these "need history that isn't tracked yet" without connecting that to this specific schema constraint.

**Recommendation:** decide the shape now — see decision **D11** — *before* DEF-03's fix commits to a particular locking strategy. A separate append-only `delivery_offers` table is very likely the right answer: it's genuinely additive, it gives DEF-03's "at most one active assignment per partner" a natural home as a partial unique index on the *new* table rather than a retrofit onto `delivery_orders`, it gives the Phase 7 expiry/re-offer logic its ledger, and it gives Phase 8's scoring engine its Reliability/Load-Balance inputs — while `delivery_orders` stays the current-state row it already is.

---

## Summary table

| ID | Area | Severity | One-line | Found by |
|---|---|---|---|---|
| SEC-01 | Dependencies | Critical | Next.js has two unpatched critical advisories | Sonnet audit |
| SEC-02 | Delivery partners | High | KYC/bank data stored in plaintext | Sonnet audit |
| SEC-03 | Auth | Medium | Hard-coded personal admin emails, permanent (role-only self-heal) | Sonnet audit + Opus refinement |
| SEC-04 | API | Medium | Rate limiting covers 9/95 routes, spoofable IP | Sonnet audit |
| SEC-05 | Platform | Medium | No CSP / security headers | Sonnet audit |
| SEC-06 | RBAC | Medium | `requireShopAccess` owner branch skips capability + status checks | Opus review |
| SEC-07 | API | Low | Unauthenticated, unthrottled, amplifying feasibility endpoint | Opus review |
| DEF-01 | Orders/Inventory | High | Cancelled orders never restock (fix needs a signature change, not one line) | Sonnet audit + Opus correction |
| DEF-02 | Notifications | High | Order/stock notifications defined, never sent | Sonnet audit |
| DEF-03 | Delivery | High | Same partner can be double-offered (not transactional) | Sonnet audit |
| DEF-04 | Delivery | **High** *(re-graded from Medium)* | Accept/reject race; pickup/deliver not atomic — reachable with no crash, leaves a rider unpaid | Sonnet audit + Opus re-grade |
| DEF-05 | Delivery | Low | "Busy" *and* soft-delete eligibility defined differently in two places | Sonnet audit + Opus extension |
| DEF-06 | Orders | Medium *(P1, not P0 — see gap analysis)* | Unpaid order can be marked CONFIRMED; no money actually moves | Sonnet audit + Opus re-priority |
| DEF-07 | Wallet | Low | Auto-recharge setting has no effect | Sonnet audit + Opus correction |
| DEF-08 | Orders | **High** | Customer can cancel a dispatched order, full refund incl. delivery fee, rider unpaid, `ORDER_CANCEL_OWN` never enforced | **Opus review** |
| DEF-09 | Delivery | Medium (live) / High (blocks Phase 7-8) | Reassignment destroys offer history; a partner can be re-offered a job they just rejected | **Opus review** |

Sixteen findings total. All P0/P1 items feed [GOKESARI_GAP_ANALYSIS.xlsx](./GOKESARI_GAP_ANALYSIS.xlsx) (GAP-001…005, GAP-071…074) and are sequenced in [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md), per the brief's own priority: fix and protect before extending. See [GOKESARI_OPUS_REVIEW.md](./GOKESARI_OPUS_REVIEW.md) for the full independent review this file's corrections are drawn from — including two things the audit got right and correctly raised no finding on.
