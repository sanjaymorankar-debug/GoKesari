# GoKesari — Implementation Roadmap

*This is the Phase 2/3 deliverable: existing-vs-target comparison resolved into an ordered build plan. **No application code has been changed.** Everything below is planning output, per the brief's own instruction not to start major coding until discovery, gap analysis and architecture are complete.*

Companion documents: [EXISTING_ARCHITECTURE](./GOKESARI_EXISTING_ARCHITECTURE.md) · [TARGET_ARCHITECTURE](./GOKESARI_TARGET_ARCHITECTURE.md) · [FEATURE_INVENTORY.xlsx](./GOKESARI_EXISTING_FEATURE_INVENTORY.xlsx) · [GAP_ANALYSIS.xlsx](./GOKESARI_GAP_ANALYSIS.xlsx) · [AUDIT_FINDINGS](./GOKESARI_AUDIT_FINDINGS.md) · [DATABASE_CHANGE_PLAN](./GOKESARI_DATABASE_CHANGE_PLAN.md) · [API_CHANGE_PLAN](./GOKESARI_API_CHANGE_PLAN.md) · [TEST_PLAN](./GOKESARI_TEST_PLAN.md) · [DEPLOYMENT_PLAN](./GOKESARI_DEPLOYMENT_PLAN.md) · [BASELINE_TEST_REPORT.xlsx](./GOKESARI_BASELINE_TEST_REPORT.xlsx) · [REGRESSION_MATRIX.xlsx](./GOKESARI_REGRESSION_MATRIX.xlsx)

---

## 0. A model-strategy note, up front

The brief asks for **Opus 5** to own this discovery/audit/architecture/gap-analysis phase, with **Sonnet 5** reserved for routine implementation. The Phase 1–3 output — the audit, both architecture documents, both spreadsheets, the findings, and this roadmap — was first produced by **Sonnet 5**, because that was the model the session was running as. The user then had the "Final Opus 5 review" the brief calls for done as a bounded subagent task, over the actual code, not just this session's own write-up. **Verdict: sound enough to start Phase 1 on, with the corrections below folded in** — ten of the twelve original findings were re-derived independently and confirmed exactly accurate; three structural corrections and four new findings came out of it and are now incorporated throughout this document. Full report: [GOKESARI_OPUS_REVIEW.md](./GOKESARI_OPUS_REVIEW.md).

## 1. Overall verdict

The application is substantially more built than a "greenfield with gaps" framing would suggest: **70 of 158 target features are already working and tested**, RBAC/audit/wallet/checkout/subscriptions are genuinely solid (proven by concurrency tests, not just present), and a second full subsystem (Product Master) already exists for catalogue data quality. The gaps are concentrated in exactly the areas the brief calls "the local-marketplace differentiators": **Society, Marketing, and Settlement have no code at all**, the **delivery assignment engine** is a deliberately-scoped Phase-1 stub with real lifecycle bugs, and a meaningful slice of **already-built, already-tested service code has no route or screen reaching it** (28 features — thresholds, MRP governance, brand/category admin, order lookup — are "paid for" but unreachable).

| Inventory status | Count | Meaning |
|---|---:|---|
| `EXISTING_WORKING` | 70 | Leave unchanged |
| `EXISTING_PARTIAL` | 22 | Complete carefully |
| `EXISTING_BROKEN` | 2 | Fix with regression protection first |
| `EXISTING_PLACEHOLDER` | 11 | Service exists, nothing reaches it — wire it up |
| `MISSING` | 53 | Implement |

(11 rows above are `EXISTING_PLACEHOLDER` at the *feature* level in the inventory; the reachability scan underlying it found 76 individual *functions* with no caller — several placeholder features bundle more than one such function. Two rows moved from `WORKING` to `PARTIAL` after the Opus review — `RBAC-02` and `CUS-18` — because a claim of full protection in each turned out to have a real hole: see SEC-06 and DEF-08.)

## 2. Critical stop conditions — checked, four surfaced rather than silently passed

Per the brief's §43. The first pass reported two near-misses; the Opus review found the net had been too small and added two more that are arguably the conditions themselves, not near-misses of them:

1. **A critical security vulnerability in an existing dependency** (finding SEC-01) — not in GoKesari's own code, but in the framework it runs on, currently unpatched in production. Reported, not fixed, pending the go-ahead in §3.
2. **The checked-out branch was a stale duplicate of `origin/staging`**, not a real feature branch — reported in the deployment plan §4 rather than assumed away.
3. **"A security vulnerability exists in existing functionality"** — this condition is arguably *met*, not narrowly missed: **DEF-08** (a customer can cancel a dispatched order and keep a full refund, in existing, shipped, customer-facing code) and **SEC-06** (`requireShopAccess` grants shop write access on ownership alone, ignoring both role and shop status) were both missed by the first pass rather than judged and excluded.
4. **"Business logic conflicts with existing implementation" / data-loss risk on a schema change** — **DEF-09** shows the roadmap's own Phase 7 commitment ("offer expiry, re-offer excluding prior rejecters") cannot be delivered additively as originally scoped: it needs either a new table (fine) or replacing an unconditional unique index on `delivery_orders.order_id` once that table holds live rows (not additive, and exactly the kind of change the database change plan §5 says needs reverse SQL written in advance). This is now surfaced as decision **D11** rather than left as an implementation-time surprise inside Phase 7.

Everything else in the brief's §43 list was checked and genuinely not triggered: existing auth, payment gateway, and database do not need replacing; no existing API needs to become incompatible; no major architectural rewrite is required (the target architecture maps onto the existing one — see [TARGET_ARCHITECTURE](./GOKESARI_TARGET_ARCHITECTURE.md) §6); deployment configuration was only read, never touched; existing production data is not at risk from anything in this plan once D10/D11/D12 are answered before their respective phases.

## 3. Decisions needed from the user before the relevant phase can start

These are genuine business/product calls, not implementation details — flagging them here rather than guessing, per the brief's own instruction not to make a risky decision silently.

| ID | Decision | Blocks |
|---|---|---|
| D1 | Wallet-only checkout, or add direct UPI/card/net-banking + COD? | Phase 5 (payment work), settlement design |
| D2 | SMS/OTP/push provider (needed for delivery OTP, phone verification, real notifications; India SMS needs DLT registration) | Delivery OTP, phone verification, real notification transports |
| D3 | Branch/deploy policy: build from `origin/staging`; nothing merges to `main` without explicit approval (already the project's practice — restated here to confirm it still holds) | All phases |
| D4 | Approve the security remediation set (SEC-01…05) before or alongside feature work | Phase 1 below |
| D5 | Society model: its own verified entity? Who verifies it? Link to addresses and to riders? | Phase 8 (Society) |
| D6 | Commercial/tax model: commission %, delivery-fee split, settlement cadence, tax-inclusive pricing? | Phase 9 (Settlement), invoicing |
| D7 | External price references: keep the no-scraping policy — which licensed/partner sources, if any, may be shown to customers? | Price-comparison's external-reference column |
| D8 | Order-state model: extend `order_status` additively (keep `CONFIRMED` = paid) or add a separate fulfilment-status column? **Implementation note (Opus review):** `PAID_STATUSES` (`orders.ts:65-71`) is a hand-maintained array, not exhaustiveness-checked the way `ALLOWED_TRANSITIONS` is — adding a new post-payment state to the enum will *not* produce a compile error if that state isn't also added to `PAID_STATUSES`, and the silent failure mode is `cancelOrder` refusing to refund an order that actually was paid. Whoever implements D8 must update both, and a test should assert the two stay in sync. | Phase 4 (order engine), Phase 6 (shop accept/reject), DEF-06's fix (temporary shape until D8 lands) |
| D9 | Marketing scope + legal review before any send capability is built | Phase 10 (Marketing) |
| D10 | **Cancellation policy** — **RESOLVED by the user, 2026-09-22.** `CONFIRMED`: customer self-cancel, full refund. `PREPARING`/`READY`: customer self-cancel blocked (shop/operator only). `OUT_FOR_DELIVERY`: customer self-cancel re-enabled, goods-only refund (delivery fee kept), rider still paid regardless. No new fee introduced — uses the amounts an order already carries. Full detail: [AUDIT_FINDINGS](./GOKESARI_AUDIT_FINDINGS.md) DEF-08. | ~~Phase 1's DEF-01 fix (same function as DEF-08)~~ **unblocked**; GAP-027 (returns/refunds) should implement this same rule, not a separate one; D6 (settlement) should account for delivery fees the platform keeps on a dispatched-cancel) |
| D11 | **Delivery offer/assignment history model** (added by the Opus review). New append-only `delivery_offers` table, or replace the unconditional unique index on `delivery_orders.order_id`? One path is additive; the other is a non-additive migration on a table that will hold live rows by then. | DEF-03's locking-strategy choice, Phase 7 (expiry + re-offer), Phase 8 (Reliability/Load-Balance scoring inputs) |
| D12 | **Shop-owner capability revocation semantics** (added by the Opus review). Should shop ownership alone keep granting write access forever, or should role demotion and shop suspension revoke it? This changes behaviour for every existing shop owner — the brief's own "ambiguous existing behaviour" stop condition. | SEC-06's fix, GAP-034 (shop suspend actually working), Phase 3, Phase 8 (the Society-Administrator guard should not copy today's `requireShopAccess` as-is) |

## 4. Phase order

Adapted from the brief's §34, reordered where this codebase's actual dependencies require it (e.g., fixing the delivery lifecycle before building a scoring engine on top of it). Each phase is independently shippable and ends with: code → unit test → API test → integration test → regression test (per the regression matrix) → commit → **only then** the next phase, per the brief's §35/§36.

**Structural fix from the Opus review:** the original single "Phase 1" put behaviour changes to `EXISTING_PARTIAL` features ahead of this document's own §5 rule that characterization tests come first. Phase 1 is now split into **1a** (tests) and **1b** (fixes), with 1b depending on 1a — resolving the contradiction rather than leaving the phase table and §5 disagreeing with each other.

| Phase | Scope | Depends on | Model (per the brief's own split) |
|---|---|---|---|
| **1a — Characterization tests for the routes Phase 1b touches** | Route-level tests (auth, validation, status codes, and — critically — a test reproducing each defect's *current* wrong behaviour) for: checkout, order-status (incl. cancel), wallet top-up/verify, delivery-assignment (assign/accept/reject/pickup/deliver) | — | Sonnet |
| **1b — Security & defect remediation (P0)** | 16 findings total (SEC-01…07, DEF-01…09). **Order matters:** (1) **DEF-08 + DEF-01 together, in one change to `cancelOrder`**, implementing D10's resolved policy exactly (table in [AUDIT_FINDINGS](./GOKESARI_AUDIT_FINDINGS.md) DEF-08) — both edit the same function, so DEF-01's restock fix alone would ship the DEF-08 abuse path behind a newly-passing test; (2) DEF-03/DEF-04/DEF-05, **narrowed** to transaction+locks+guarded-updates+unified-eligibility-predicate only — the "offer expiry + re-offer excluding rejecters" piece is *not* in this phase, see Phase 7; (3) DEF-02, DEF-06 (re-graded P1, not blocking), DEF-07; (4) SEC-01 (dependency patch) can run in parallel with the others, first if convenient. SEC-02 needs a DB backup first. SEC-06/D12 and SEC-07 are **not** in this phase — SEC-06 blocks Phase 3 instead (see below), SEC-07 is P2. | Phase 1a; D4 approval | Opus reviewed this plan (see the Opus review); Sonnet implements each item as its own small PR with a regression test built on 1a |
| **2 — Regression-test foundation (remainder)** | Route-level tests for the rest of the ~82 untested routes not covered by 1a (cart, subscriptions, the remaining shop/admin routes); install Playwright and run the existing E2E spec once | — (can proceed alongside 1a/1b) | Sonnet |
| **3 — Wire up built-but-unreachable features** | Stock thresholds/alerts UI, MRP governance UI, brand/category admin, order lookup (additive routes per [API_CHANGE_PLAN](./GOKESARI_API_CHANGE_PLAN.md) §2), **and** shop suspend/reactivate — but shop suspend only after **D12** is decided and SEC-06 is fixed, or it ships a button that doesn't actually revoke anything (GAP-034/GAP-073) | Phase 2's tests as the safety net; D12 decided for the suspend item specifically | Sonnet; Opus reviews the MRP-governance and order-lookup permission wiring specifically, since those touch cross-shop visibility |
| **4 — Order engine extension** | Order-state additions (D8 — see its `PAID_STATUSES` implementation note in §3), master order, tax fields | D8 decided | Opus designs the state-machine change; Sonnet implements |
| **5 — Product-centric discovery** | Product detail page, price-comparison view, nearby-shops-by-distance, shop service radius, serviceability check | — | Sonnet |
| **6 — Shop fulfilment completion** | Accept/reject with SLA timeout, substitution/partial fulfilment, automatic assignment trigger on READY | Phase 4 | Sonnet; Opus reviews the auto-assignment trigger interaction with Phase 7 |
| **7 — Delivery/gig completion** | The narrowed DEF-03/04/05 fixes already landed in Phase 1b; this phase adds: **offer expiry + re-offer excluding prior rejecters (DEF-09, gated on D11 — this is where that work actually belongs, not Phase 1)**, OTP + proof of delivery (needs D2), failed-delivery/return-to-shop | D2 decided; **D11 decided**; Phase 1b landed | Opus designs the assignment-scoring engine and the D11 data model; Sonnet implements |
| **8 — Society** | Entity, verification, worker authorization, new role, priority engine feeding into Phase 7's scoring (Reliability/Load-Balance need Phase 7's D11 data to exist first) | D5 decided; D12 decided (the new role's ownership guard must not copy today's `requireShopAccess` as-is — see SEC-06) | Opus designs the ground-up schema and role; Sonnet implements |
| **9 — Payments & settlement** | Direct order payment (D1), commission/settlement/payout ledger (D6, including any cancellation fee from D10), invoicing | D1 and D6 decided | Opus designs the ledger; Sonnet implements against it |
| **10 — Marketing** | Consent + suppression + frequency caps **first**, campaigns/segmentation only after (D9) | D9 decided, legal review done | Sonnet, with an Opus/legal review gate before any send capability ships |
| **11 — Analytics & reporting** | Shop sales reports, admin order search filters, exports | — | Sonnet |
| **12 — Final regression & Opus review** | Full suite + new tests + critical E2E scenarios (Test Plan §4) + security review + architecture coherence check, per the brief's §42 | Every prior phase | Opus |

## 5. Existing-feature protection rule (applies to every phase above)

Per the regression matrix: before touching any `EXISTING_WORKING` or `EXISTING_PARTIAL` feature, confirm its "Protection level" column. **41 features currently have no automated test at all** (mostly UI-only screens and a handful of services) — for those, write characterization tests *before* changing behaviour, as their own commit, exactly as the brief's §31 requires ("if an existing feature breaks, stop new feature development, fix the regression first" — the cheapest way to honour that is to have a test that would catch the break in the first place).

## 6. What "done" means for anything built under this roadmap

Per the brief's own §40 — not satisfied by code existing alone:

```
UI → API → BUSINESS LOGIC → DATABASE → RESPONSE → UI → TESTS → REGRESSION
```

The 11 `EXISTING_PLACEHOLDER` features in this audit are the concrete, present-tense illustration of why this bar matters: every one of them has working, tested business logic and a real database column — and is not "done" by this definition, because nothing reaches it from a screen or an API a user can call.

## 7. Immediate next steps (before Phase 1a starts writing code)

1. **D10 is resolved** (2026-09-22 — see the table in [AUDIT_FINDINGS](./GOKESARI_AUDIT_FINDINGS.md) DEF-08). Still open before Phase 1b: user confirms **D3/D4**. **D11** is not a Phase 1 blocker (only Phase 7) but is worth deciding early if convenient.
2. Branch created off `origin/staging` (not the current stale branch — see [DEPLOYMENT_PLAN](./GOKESARI_DEPLOYMENT_PLAN.md) §4).
3. Playwright browser installed and the existing E2E spec run once, to get a real baseline (Test Plan §5).
4. Confirm the daily-order cron is actually scheduled on both hosts (Test Plan §5) — silent failure here is the single most damaging outage this system can have, per its own deployment doc.
5. Phase 1a begins: route-level characterization tests for checkout, order-status/cancel, wallet, and delivery-assignment — including tests that reproduce today's DEF-08 behaviour exactly as it stands (unrestricted self-cancel, full refund at every pre-terminal status) *before* anything about it changes, so the fix's correctness is provable against a known "before."
6. Phase 1b begins once 1a is green and D4 is confirmed: the DEF-08 + DEF-01 combined fix to `cancelOrder`, implementing D10's table exactly, first (same function, same commit) — then the rest of the 16 findings in the order §4 lays out.
