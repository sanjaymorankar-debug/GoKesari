# Seller / customer split — code plan (19 Oct 2026)

The owner chose **two physically separate databases** (19 Oct). This page is
how the code gets there without a risky rewrite, and what is left to do.

## 1. The layout: "overlay"

| Database | Holds | Who connects |
|---|---|---|
| **core** = customer database (today's `neondb`) | customers, addresses, carts, orders and everything after an order, customer wallet, vouchers, coupons, subscriptions **and** the platform tables (users, roles, settings, audit, events, notifications, delivery partners) | the website (`DATABASE_URL`) |
| **seller** database | the 137 seller tables: shops, KYC and documents, catalogue (incl. the `pmd` product master), inventory, pricing, shop wallet, payouts | the core, through `postgres_fdw` |

In the core, every seller table is replaced by a **foreign table of the same
name** (`src/server/db/split/overlay.ts`, `scripts/db-split/overlay.ts`). The
seller rows physically live in the seller database; the website still opens
one connection and its SQL keeps working:

- **Transactions stay all-or-nothing.** `postgres_fdw` opens a matching
  transaction in the seller database and commits it in the core's pre-commit
  step, so checkout (stock + order), refunds (customer wallet + shop wallet)
  and payouts (orders + settlements) still commit or roll back together.
  (The one gap: a crash in the instant between the seller commit and the core
  commit — PostgreSQL has no two-phase commit through postgres_fdw. The daily
  `verify` reports any orphan this could leave.)
- **Joins and row locks work** (`SELECT … FOR UPDATE` is sent to the seller
  database).
- **Ids:** the core draws ids for seller tables from its own sequences
  (postgres_fdw sends every column on insert); identity columns in the seller
  database accept them.

Why not rewrite every service onto separate `sellerDb()` / `customerDb()`
connections? 176 of the 228 files that use the database touch both sides, 49
of them inside one transaction. Re-designing each as a multi-step, retrying
saga is weeks of work and the largest risk of inconsistent data. The overlay
gets the physical split with the database still guaranteeing atomicity;
hot, seller-only read paths can later talk to the seller database directly
(`sellerDb()`) where that is measurably faster.

## 2. What PostgreSQL cannot do across the two (the code changes)

1. **Foreign keys between a seller table and a core table** (113) are dropped
   in the core. Each becomes a service-layer check
   (`src/server/db/split/integrity.ts`) where a write could create an orphan,
   and `verify` reports orphans.
2. **`INSERT … ON CONFLICT (target) …` and `ON CONFLICT DO UPDATE` on a seller
   table** are not supported by postgres_fdw. Those statements are rewritten
   (select-then-insert/update under a row lock, or a plain insert with the
   duplicate handled).
3. **Cascading deletes** across the two no longer happen in the database; the
   few places that rely on them delete the children explicitly.
4. **Anything else the full test suite finds** when run against the overlay
   (§3).

All of these changes behave identically on today's single database, so they
ship to test.gokesari.com and gokesari.com before the switch, with
`DB_SPLIT_MODE=single`.

## 3. How it is proven

- The **whole test suite runs against the overlay** (a local core + seller
  database pair); CI gains a split-mode job so nothing regresses.
- Then the overlay is applied to **test.gokesari.com's** databases and the
  remote and signed-in journeys run there.
- Only then **gokesari.com**, in an owner-approved window, with a Neon branch
  as the restore point. Rollback within 7 days = restore that branch.

## 4. Progress

| Step | Status |
|---|---|
| Overlay tool (`overlay.ts`) — builds the layout, keeps sequences and identity ids working | done (spike) |
| Full suite against the overlay — list of breakages | running |
| Fixes (§2) | — |
| CI split-mode job | — |
| test.gokesari.com cut-over | — |
| gokesari.com cut-over (owner window) | — |
