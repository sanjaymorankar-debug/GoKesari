# GoKesari — Target Architecture

This is a **logical target**, mapped onto the existing codebase described in [GOKESARI_EXISTING_ARCHITECTURE.md](./GOKESARI_EXISTING_ARCHITECTURE.md) — it is not an instruction to rewrite anything. Every box below is annotated with what already exists, what is a hole in an existing subsystem, and what has no subsystem yet. Detail and sequencing live in [GOKESARI_GAP_ANALYSIS.xlsx](./GOKESARI_GAP_ANALYSIS.xlsx) and [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md).

```
                                    GOKESARI
                                       │
                  ┌────────────────────┼────────────────────┐
                  │                    │                     │
              CUSTOMER                SHOP                  GIG
          (built, extend)        (built, extend)      (built, extend)
                  │                    │                     │
                  └────────────────────┼─────────────────────┘
                                       │
                                MARKETPLACE CORE
                                (RBAC + audit: built)
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                   │
                PRODUCT               ORDER              PAYMENT
           (built + pmd bridge)   (built, extend)   (built, wallet-only — D1)
                    │                  │                   │
                    └──────────────────┼───────────────────┘
                                       │
                               DELIVERY ENGINE
                             (built, single-partner —
                              needs the scoring engine)
                                       │
                                  SOCIETY
                                 (missing)
                                       │
                               SUBSCRIPTION
                              (built, wallet-funded)
                                       │
                                MARKETING
                                (missing)
                                       │
                                SETTLEMENT
                                (missing)
                                       │
                             ADMIN / OPERATOR
                              (built, extend)
```

## 1. Layer-by-layer mapping

### Customer, Shop, Gig (top layer)
All three already have a role, a self-service registration flow, and an owner/operator approval workflow following the same pattern (`PENDING_APPROVAL`/`REGISTERED` → admin review → `APPROVED`/`REJECTED`/`SUSPENDED`, every transition audited). **Extend, do not replace.** The main additions are within-role, not new roles: shop staff sub-accounts, gig OTP/proof-of-delivery, customer society/address depth. See gap IDs `SHP-*`, `DEL-*`, `CUS-*`.

### Marketplace core (RBAC, audit)
Already the strongest part of the codebase: a server-side capability matrix (76 permissions, 5 roles), ownership guards separate from capability checks, and an audit log on every sensitive mutation. A new **Society Administrator** role (§5 below) slots into this matrix the same way `DELIVERY_PARTNER` did — no restructuring needed.

### Product (catalogue + Product Master)
Two systems already coexist here by design: the **marketplace catalogue** (`products`/`shop_products`, owner/operator-managed, what customers actually buy) and the **Product Master** (`pmd` schema, a separate lawful-data platform that feeds the catalogue through an explicit "promote" step). The target's "product-centric marketplace with price comparison" is a **read model over data that already exists** — grouping `shop_products` by master `products.id`/`gtin` — not a new subsystem. External e-commerce price references map onto the Product Master's `offers`/price-history tables, gated by the existing no-scraping, licensed-source-only policy (decision D7).

### Order
State machine, per-shop split, idempotent checkout, wallet-atomic — all built. The target flow adds a **shop accept/reject step** and richer terminal states (`RETURNED`, `DISPUTED`, `PARTIALLY_REFUNDED`) that the current 11-state enum doesn't have (decision D8). This is an additive enum change plus new transitions in the existing state machine, not a new engine.

### Payment
Cashfree integration, webhook-verified, idempotent — built, but wallet-top-up only. The target's "customer pays at checkout" step is a real business-model question (decision D1): either keep wallet-only (simplest, already proven), or add a second payment purpose (`ORDER`) alongside the existing `WALLET_TOPUP` one, reusing the same gateway, webhook and idempotency machinery.

### Delivery engine
Built to Phase-1 scope by explicit design (its own file header says so): single nearest online partner, Haversine distance, no batching, no scoring engine, no zones. The target's assignment-scoring engine (§4) and society-priority fallback chain (§5) are new logic **inside the existing service** (`delivery-assignment.ts`), not a new subsystem — but the current offer lifecycle has atomicity and race gaps (findings DEF-03/DEF-04) that should be fixed *before* a scoring engine is layered on top of it, or the scoring engine inherits the same races.

### Society
**Nothing exists.** No table, no role, no concept anywhere in code or schema (confirmed by an exhaustive grep — see the inventory). This is the one true whitespace area in the target architecture and needs ground-up design: entity, verification workflow (can reuse the shop-approval pattern), worker authorization list, and its own role. Decision D5.

### Subscription
Built and well-tested (idempotent daily-order engine, pause/resume/skip/override, wallet-funded). Missing: a delivery time slot, and — once Society exists — subscriptions should respect society-scoped delivery policies.

### Marketing
**Nothing exists** beyond a single consent-type enum value (`MARKETING_COMMUNICATIONS`) with no capture UI. This is the second true whitespace area. Given DPDPA/TRAI exposure, build consent + suppression + frequency caps *before* any send capability, not after (decision D9).

### Settlement
**Nothing exists.** No commission, payout, or ledger code at all — this needs the commercial model decided first (decision D6: commission %, delivery-fee split, tax treatment) before any schema or service work, because every later financial report and payout depends on getting that model right once.

### Admin / Operator
Built and broad (a 603-line admin console with ~18 capability-gated sections). The operator dashboard is a 10-line redirect to `/admin` — the brief's role-specific operator experience doesn't exist yet, though the underlying capability matrix already distinguishes operator from admin correctly.

## 2. What genuinely has no home yet

Everything else in this document is "extend an existing subsystem." These four have **no existing subsystem to extend**:

1. **Society** (entity, roles, worker authorization, priority engine) — §5.
2. **Marketing** (campaigns, segmentation, consent-gated sends) — needs consent infrastructure first.
3. **Settlement** (commission, payout, ledger) — needs the commercial model decided first.
4. **Assignment scoring engine** (configurable weights, fallback chain) — needs the delivery-lifecycle bug fixes first, or it scores races instead of riders.

## 3. Order state machine (target, additive)

Today's 11 states already form a coherent core:

```
PENDING → CONFIRMED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED
   ↘ CANCELLED / PAYMENT_FAILED / WALLET_INSUFFICIENT
              ↘ REFUND_PENDING → REFUNDED
```

The target adds a shop decision point and richer exception terminals:

```
PENDING → PAID → SHOP_PENDING → ACCEPTED → PREPARING → READY
    → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED
                                                    ↘ RETURNED
   ↘ REJECTED / CANCELLED / FAILED
   ↘ REFUND_PENDING → REFUNDED / PARTIALLY_REFUNDED
   ↘ DISPUTED
```

**Recommendation (for decision D8):** treat `CONFIRMED` as still meaning "paid" (do not repurpose it), insert `SHOP_PENDING`/`ACCEPTED`/`REJECTED` between it and `PREPARING`, and add `RETURNED`/`DISPUTED`/`PARTIALLY_REFUNDED` as new terminal/near-terminal states. This is additive to `orderStatusEnum` and to `ALLOWED_TRANSITIONS` in `orders.ts` — every existing transition keeps working, and old order rows remain valid under the new enum (Postgres enum values can only be added, which Drizzle's migration generator handles as an `ALTER TYPE ... ADD VALUE`).

## 4. Gig assignment scoring (target, once the lifecycle is fixed)

The brief's formula:

```
Assignment Score =
  Society Priority + Preferred Worker Score + ETA Score + Distance Score
  + Availability Score + Reliability Score + Load Balance Score + Batch Efficiency Score
```

Maps onto the existing `delivery-assignment.ts` / `delivery-feasibility.ts` split as follows: **Distance** and **Availability** already exist (Haversine + online/approved/radius filtering); **ETA** already exists in `delivery-feasibility.ts`'s travel-time estimate. **Society Priority** and **Preferred Worker Score** need the Society subsystem (§5) to exist first. **Reliability** and **Load Balance** need history that isn't tracked yet (completed/rejected counts, current active-assignment count is available but unused as a scoring input). **Batch Efficiency** is explicitly out of scope until multi-order batching exists (documented as Phase 2 in the code itself).

Recommended shape: a small, versioned rules table (weights per factor, one active row — same pattern as `delivery_earnings_config`) read by a pure scoring function, so tuning weights is a data change, not a deploy. Fallback chain (`Preferred Society Worker → Authorized Society Worker → Nearby General Worker → Expanded Pool → Operations Escalation`) is new control flow around the existing "find nearest eligible" query, reusing it as the "nearby general worker" step.

## 5. Society (target, ground-up)

No existing pattern to extend, but two existing patterns to **copy**:

- **Entity + verification**: model `societies` the way `shops` are modelled — self- or operator-registered, `PENDING_VERIFICATION → VERIFIED/REJECTED`, operator-gated, audited. Add `society_id`/`block`/`flat` to `addresses` (additive, nullable).
- **Worker authorization**: model `society_workers` the way `role_permissions` and `shop_classification_history` are modelled together — a membership table (`society_id`, `delivery_partner_id`, `status`: `AUTHORIZED`/`PREFERRED`/`REVOKED`) plus an immutable history table, changed only by a Society Administrator or operator/admin, always audited.
- **New role**: `SOCIETY_ADMIN`, added to `userRoleEnum` and the permission matrix exactly like `DELIVERY_PARTNER` was added — new permissions (`society.worker.authorize`, `society.worker.revoke`, mirroring the existing `shop:*` naming convention), an ownership guard modelled on `requireShopAccess` (does this society belong to this administrator?).

## 6. What must NOT change

Per the golden rule (existing working functionality is preserved, extended, or fixed — never replaced without justification):

- **Auth**: Google OAuth + Auth.js stays. No target requirement needs a different auth system.
- **Payment gateway**: Cashfree stays, whatever decision D1 lands on (add a second purpose; don't swap gateways).
- **Database**: PostgreSQL + Drizzle stays. Every schema change below is additive (new tables, new nullable columns, new enum values) — none requires dropping or renaming an existing table, column, or ID scheme.
- **Wallet ledger, order idempotency, RBAC matrix, audit log**: these are the load-bearing correctness guarantees (proven by the concurrency tests) that every new subsystem above should build on top of, not around.

## 7. Sequencing

Full detail and phase-by-phase ordering: [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md). In one line: fix the P0 defects and security items first (they sit underneath everything else, including the assignment engine and the order state machine), then build in dependency order — RBAC extensions → catalogue/inventory completion → order-state extension → delivery-lifecycle fix → assignment scoring → society → settlement → marketing, matching the brief's own §34 sequence adjusted for what this codebase already has.
