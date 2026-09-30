# GoKesari — Existing Architecture

*Audited 2026-09-22 against `D:\Claude_development\bkesari`, branch `feature/pmd-review-decide` (commit `e76ccf2`), whose content equals `origin/staging` (`40ba7b4`). `origin/main` is one merge behind at `caaa491`. See §9 for exactly what differs.*

This document describes what **exists**, not what should be built — that is [GOKESARI_TARGET_ARCHITECTURE.md](./GOKESARI_TARGET_ARCHITECTURE.md). Every claim below was verified by reading the source, running the test suite, or a direct probe; anything not verified is marked so explicitly.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16.3.1 (App Router, Turbopack), React 19.2.8, TypeScript strict | One deployable unit: pages, API routes and server code share a repo and a build. |
| Styling | Tailwind CSS v4 | |
| Database | PostgreSQL 16 (hosted: Neon, serverless) | |
| ORM | Drizzle ORM 0.45 + `postgres.js` (not Prisma) | Deliberate deviation — Prisma's binary engine could not be fetched in the original build environment; Drizzle's explicit `FOR UPDATE` / isolation-level control is also a better fit for the wallet's concurrency guarantees (ARCHITECTURE.md §1.1). |
| Auth | Auth.js v5 (NextAuth), Google OAuth, JWT sessions | Role and status are re-read from the database on every session callback — a stale token cannot carry stale privileges. |
| Validation | Zod v4 | Every external input is parsed at the server boundary. |
| Payments | Cashfree (sandbox/production) | Wallet top-up only; see §6. |
| Client state | Zustand | UI-only; cart/wallet/subscription state is server-owned. |
| Tests | Vitest (unit + integration against real Postgres), Playwright (E2E, not run in this audit) | |
| Excel | ExcelJS | Chosen over `xlsx`/SheetJS for registry/security reasons (RBAC_PLAN.md). |

Two applications share this one codebase: the **marketplace** (`src/server/services/*`, the original build) and the **Product Master data platform** (`src/server/pmd/*`, `pmd` Postgres schema), added later and bridged into the marketplace catalogue only at an explicit "promote" step (§7).

## 2. Module map (as built)

```
src/
  server/
    db/            schema.ts (2,525 lines, 76 tables/enums), client, migrate.ts, seed.ts
    services/      31 files — marketplace business logic (pure, tested, no React)
    authz/         permissions.ts (76 permissions, 5 roles), guards.ts (capability + ownership)
    api/           handler.ts (parse → authorize → service → respond), rate-limit.ts
    pmd/           Product Master: sources, normalize, match, pipeline, export, taxonomy, services
  app/
    (public)       /, /categories, /category/[type], /dairy, /bakery, /shops, /shops/[slug], /search, /about, /contact, /legal/*
    (customer)     /cart, /orders, /wallet, /subscriptions, /profile, /grievance
    (shop)         /shop, /shop/orders, /shop/prices, /shop/register
    (delivery)     /delivery-partner, /delivery-partner/apply, /delivery-partner/register
    (admin)        /admin (603 lines, every section capability-gated), /admin/shops, /admin/product-master, /operator (redirects to /admin)
    api/           95 route handlers under 45 route groups
  components/      43 files — presentational + light client interaction, no direct DB access
  lib/             money (integer paise), dates, errors, env, geo/haversine, shop-types, pan-crypto, cashfree-checkout
tests/
  unit/ (9 files) integration/ (33 files) e2e/ (1 file, Playwright)
drizzle/           16 forward-only SQL migrations, 0000–0015, no down-migrations
```

Counts (2026-09-22): 43 pages, 95 API routes, 43 components, 31 marketplace services + 20 pmd modules, 76 exported permissions, 5 roles, 628 automated tests.

## 3. Data model

76 tables/enums in one PostgreSQL database, two schemas:

- **`public`** — the marketplace: users/auth (Auth.js-managed), shops (+classification history, GST/PAN verification, registration/fee/payment), delivery partners and delivery orders, catalogue (products, categories, brands, shop_products, MRP history, stock alerts), cart/orders/order_items, wallet + wallet_transactions, subscriptions (+overrides, generated orders), vouchers (+redemptions, uploads), price-update requests, Excel uploads, referrals, grievances, consents, notifications, audit_logs, maps_api_call_log.
- **`pmd`** — the Product Master data platform: master products, offers, price history, sources, taxonomy, review/duplicate queue, quality scoring, import jobs. Coupled to `public.products` only through `pmd.catalogue_link` (a one-way "promote" bridge, never a live join).

Money is **always integer paise** (`bigint`); quantities are **always integer milli-units** — both enforced by DB `CHECK` constraints as well as application code, so a bug can't silently produce a float or a negative balance. IDs are UUIDv4 except two human-readable sequences (`shops.registration_number` = `BKS-000123`, `products.code` = `P00001`), both DB-sequence-allocated so concurrent inserts can't collide.

Full migration history (16 files, `0000`→`0015`, 2026-08-18 → 2026-09-19) is in [GOKESARI_DATABASE_CHANGE_PLAN.md](./GOKESARI_DATABASE_CHANGE_PLAN.md) §1.

## 4. Roles and authorization

Five roles: `CUSTOMER`, `SHOP_OWNER`, `OPERATOR`, `ADMIN`, `DELIVERY_PARTNER` (the brief's target list maps onto these — see target architecture §2). `DELIVERY_PARTNER` and `SHOP_OWNER` both retain the base `CUSTOMER` permission set, so a shop owner or rider can still shop.

Authorization is a **capability matrix** (`src/server/authz/permissions.ts`, 76 named permissions) checked server-side on every mutation — never inferred from the UI. Two separate questions are always asked:

1. **Capability** — may this *role* ever do this? (`can(role, permission)`)
2. **Ownership** — does this *specific row* belong to this user? (`requireShopAccess`, `requireSubscriptionAccess`)

Both are *meant* to pass — but an Opus review (2026-09-22, see [GOKESARI_OPUS_REVIEW.md](./GOKESARI_OPUS_REVIEW.md)) found this isn't quite true today: `requireShopAccess`'s owner branch returns as soon as ownership matches, **before** any `can()` call, so a demoted or suspended shop owner keeps every write the guard protects (finding SEC-06). Role is attached to the session server-side from the database and is never accepted from a request body, so self-escalation to `OPERATOR`/`ADMIN` is structurally impossible — that guarantee is intact; it's specifically the owner-branch shortcut in the *ownership* guard that skips the capability half of the check.

27 of the 76 permissions are defined but never referenced by name outside the matrix file (mostly because ownership checks or the route layer enforce the equivalent behaviour some other way, or because the capability has no route yet — tracked as gaps, not orphans, in the gap analysis).

## 5. Order and fulfilment flow (as built)

```
CART (multi-shop) → CHECKOUT (split into one order per shop, atomic per shop)
  → wallet debit + stock consumption + order row, all in one transaction
  → order status: PENDING → CONFIRMED (paid)
SHOP: CONFIRMED → PREPARING → READY  (owner/operator, PATCH /api/orders/[id]/status)
SHOP (manual click): READY → delivery-partner OFFER (nearest online, in-radius, idle partner)
PARTNER: OFFERED → ACCEPTED → PICKED_UP (order → OUT_FOR_DELIVERY) → DELIVERED
CANCEL: any pre-terminal state → CANCELLED → (if paid) REFUNDED (wallet credit)
```

State machine: 11 states (`orders.status`), transitions validated in `orders.ts:canTransition`; illegal transitions return `409`. There is **no accept/reject step for the shop** — a paid order lands directly in `CONFIRMED`; the shop can only advance or cancel it. There is **no OTP or proof of delivery** — a rider marks `DELIVERED` unconditionally. Delivery assignment offers exactly one partner at a time with no expiry (see [GOKESARI_AUDIT_FINDINGS.md](./GOKESARI_AUDIT_FINDINGS.md) DEF-03/DEF-04).

## 6. Payments and wallet

**Wallet-only marketplace.** There is no direct order payment — a customer tops up a wallet via Cashfree, and every purchase (direct or subscription) is a wallet debit. This is a real business-model difference from the brief's target flow (`Payment` happens once, at checkout) and is flagged as decision **D1** in the gap analysis.

Wallet integrity (proven by concurrency tests, not just claimed):
- One wallet per user, `balance_paise bigint CHECK (balance >= 0)`.
- Every change writes an **immutable** `wallet_transactions` row (`previousBalance`, `amount`, `newBalance`); rows are never updated or deleted.
- Mutations run inside `db.transaction()` opening with `SELECT … FOR UPDATE`, so concurrent debits serialize; 10 concurrent ₹100 debits against ₹1,000 leave exactly ₹0.
- `wallet_transactions.idempotency_key` is `UNIQUE` — a retried operation returns the original transaction instead of double-charging.
- The wallet is credited **only** after the server independently confirms payment with Cashfree's own API (webhook, HMAC-verified over the raw body, or the client-invoked verify endpoint) — never from anything the client reports.

## 7. Product Master (pmd) — a second, bridged system

A separate data platform (`src/server/pmd/*`, `pmd` Postgres schema, ~4,700 lines) collects product data from **open data only** (Open Food/Beauty/Products Facts dumps, Open Prices API, and file feeds) — every marketplace source and GS1 is registered `BLOCKED_NEEDS_AGREEMENT` by policy; there is no scraping anywhere. Pipeline: normalise → match → load into a master (with duplicate-review queue) → offers/price history → quality scoring → Excel export. It is coupled to the marketplace catalogue only through an explicit, staff-triggered **promote** step (`pmd.catalogue_link`), never a live join — promoting a master record creates or updates a `public.products` row.

This is the only area with HTTP route-level tests (`tests/integration/pmd-api.test.ts`, an OpenAPI-vs-code-drift test, and a generated-docs-vs-code-drift test). See [PILOT_REPORT.md](../product-master/PILOT_REPORT.md) for its own, separately validated status; the initial pilot promoted 837 products (2026-09-21), and after a later duplicate-review pass the **test** database currently holds 1,179 (§9 below) — on the **test** database only, per user instruction; live has no `pmd` schema at all.

## 8. Cross-cutting concerns

- **Audit log** (`audit_logs`): actor, role, action, entity, previous/new value, written on every sensitive mutation (approvals, classification changes, price changes, wallet adjustments, refunds, role changes, order status changes, delivery assignment, GST/PAN verification, PAN reveal). Viewer exists for admin (full) and operator (limited).
- **Notifications**: in-app only is wired up; EMAIL/SMS/PUSH are console-log stubs behind a real transport seam. Most event types are defined (`NOTIFICATION_TYPES`) but never emitted — see finding DEF-02.
- **Rate limiting**: in-process fixed-window counter, 9 of 95 routes, documented as a known scaling limit (swap for Redis before horizontal scaling). See finding SEC-04.
- **Legal/compliance**: DPDPA-style consent recording, IT Rules 2021 grievance redressal (24 h acknowledgment / 15-day disposal ladder), Consumer Protection (E-Commerce) Rules 2020 seller-identity fields (GSTIN, FSSAI, legal name), a compliance checklist dashboard, and ten `/legal/*` policy pages. Also see [COMPLIANCE.md](../../COMPLIANCE.md).
- **Geo**: Google Geocoding is called exactly once per shop/address/partner ("Confirm location"), never re-called on routine reads; Haversine (straight-line) distance drives delivery-partner ranking and window feasibility — never a live Routes/Distance Matrix call, to control Google Maps Platform cost (see [MAPS_USAGE.md](../../MAPS_USAGE.md)).

## 9. Infrastructure and deployment (as configured, not fully re-verifiable from the repo)

- **Hosting**: Hostinger Node.js Web App Hosting. `test.gokesari.com` tracks GitHub branch `staging`; `gokesari.com` (**live**) tracks `main`; both auto-deploy on push. **Merging to `main` deploys live** — this was already learned the hard way once (an hPanel "Change repository" action wiped 16 env vars and produced a 500 on test); the correct way to change a tracked branch is Deployments → Redeploy → "Settings and redeploy", never "Change repository".
- **CI** (`.github/workflows/ci.yml`): on push/PR to `main`/`staging` — `npm ci` → migrate → typecheck → lint → test → build, against a Postgres 16 service container. Runs Node 22; the hosts and local dev run Node 24 (see finding in the audit doc — low severity, but worth aligning).
- **Databases observed** (read-only, from prior sessions' notes, not re-verified live in this audit): the **test** app's database has the `pmd` schema migrated and 1,179 promoted products (after de-duplication); **live** has no `pmd` schema and an empty/unused catalogue. This audit's own database work (§below) never touched Neon — it ran exclusively against a disposable local Postgres cluster.
- **Repository state**: the checked-out branch (`feature/pmd-review-decide`) is **not** a distinct line of work — its tree is byte-identical to `origin/staging`; it appears to be a stale local branch. `origin/main` is one merge (`#8`, promoting staging→main) behind `origin/staging`. Six other feature branches exist on `origin`, all already merged into `staging`. **Recommendation:** start new work from `origin/staging`, and clean up the stale merged branches (see §12 of the gap analysis / roadmap).

## 10. What this audit verified, and how

| Check | Method | Result |
|---|---|---|
| Full test suite | `npx vitest run` against a disposable local Postgres 16 cluster (never Neon) | 626/628 passed; 2 failures are a Windows-only CRLF artefact in a doc-drift test, confirmed by byte comparison (identical after CRLF→LF) |
| Typecheck | `npm run typecheck` | Clean |
| Lint | `npx eslint src tests` (same command as CI) | 0 errors, 3 pre-existing unused-variable warnings |
| Production build | `npm run build` against the local database | Succeeds, 39 static/dynamic routes, no warnings |
| Dependency audit | `npm audit --omit=dev` | 2 critical (Next.js), 1 high (sharp), 2 moderate (uuid, exceljs) — see finding SEC-01 |
| Hosted auth providers | Read-only `GET /api/auth/providers` on both hosts | Both expose only Google — the dev-only credentials provider is correctly absent in production |
| Route-level auth coverage | Static scan of all 95 route files for a guard call | 3 routes have none, and all 3 are intentionally public (public catalogue read, delivery-window preview, grievance-ticket lookup by ticket+email) |
| Reachability | Every exported service function (241) searched for a caller in `app`/`components`/`lib` | 76 have none — tracked individually in the feature inventory, not assumed dead |

Full detail: [GOKESARI_BASELINE_TEST_REPORT.xlsx](./GOKESARI_BASELINE_TEST_REPORT.xlsx), [GOKESARI_EXISTING_FEATURE_INVENTORY.xlsx](./GOKESARI_EXISTING_FEATURE_INVENTORY.xlsx), and defects/security items in [GOKESARI_AUDIT_FINDINGS.md](./GOKESARI_AUDIT_FINDINGS.md).

Not verified (see [GOKESARI_TEST_PLAN.md](./GOKESARI_TEST_PLAN.md) §5 for why and what to do about it): Playwright E2E (no browser installed in this environment), any rendering in a real browser, the daily-order cron actually firing on either host, and anything requiring live Cashfree/Google credentials.
