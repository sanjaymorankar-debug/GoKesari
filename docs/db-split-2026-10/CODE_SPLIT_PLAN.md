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

Found by running the whole suite on the layout (first run: 850 of 2,198
tests failed, almost all from the first item):

| # | Difference across the split | Change (same result on one database) |
|---|---|---|
| 1 | postgres_fdw runs its sessions in the seller database with `search_path = pg_catalog`, so seller-side trigger functions could not find each other | the overlay pins every seller function to `search_path = "$user", public` |
| 2 | Seller triggers write lifecycle history and read rules/orders in the core | the seller database sees those core tables through postgres_fdw (`SELLER_READS_FROM_CORE`, `SELLER_WRITES_TO_CORE`) |
| 3 | `INSERT … ON CONFLICT (target)` / `DO UPDATE` is refused on a foreign table | `upsertRow()` (update, else insert under a savepoint, retry on a race); single-unique-key `DO NOTHING` loses its target; the product master talks to the seller database directly |
| 4 | Foreign keys (113) and their `ON DELETE` actions across the two are gone | the overlay records them (`split_layout_foreign_keys`); the one delete that relied on a cascade (subscription retry) deletes the children itself; `verify` reports orphans |
| 5 | A session setting cannot reach the seller database (`gokesari.inv_ledger_managed`) | migration 0085: the inventory module also leaves a mark row, stamped with the seller transaction id by a trigger |
| 6 | postgres_fdw runs the seller side at **REPEATABLE READ**: two requests changing the same seller row at once get "could not serialize access" (40001) instead of waiting | in split mode a top-level transaction is retried on 40001/40P01; savepoints that swallow errors rethrow 40001 so the whole transaction retries |
| 7 | A relayed error keeps its code and message, not `constraint_name` | the Shop Act duplicate check also reads the index name from the message |
| 8 | Sequence-backed defaults | the core keeps the sequences; identity columns get a core-drawn default; composite defaults (`'BKS-' || …`) are kept as they are |

All of these behave identically with `DB_SPLIT_MODE=single`, so they ship to
both sites before the switch.

### Migrations after the split

Every migration written from now on starts with a line saying where it runs:

```sql
-- split: seller   -- seller tables only (applied in the seller database)
-- split: core     -- customer / platform tables only (applied in the core)
-- split: both     -- both (types, functions both sides use)
```

On one database the line is an ordinary comment and drizzle applies the file as
always. On the split layout (`scripts/split-migrate.mjs`, used by
`MIGRATE_ON_BUILD` and `npm run db:migrate`) each migration runs where it
belongs, the core's foreign tables are imported again after a seller change,
and the seller database's links to the core after a core change. An untagged
migration is refused, so a mistake stops the build instead of reaching a site.
The bookkeeping is drizzle's own, kept in both databases; a run that stopped
half way is finished by the next one (every build compares both sides' columns
and repairs only what is out of line). New migrations must not add a foreign
key from a seller table to a customer table or back: PostgreSQL cannot enforce
it across two databases.

### Still to do before a site is switched

- **Cut-over script for a site**: restore point (Neon branch) → copy the seller
  tables into the seller database (`Database split → migrate`) → overlay +
  links on the core → Hostinger `DB_SPLIT_MODE=split`, `SELLER_DATABASE_URL`
  → smoke and signed-in journeys. Rollback within 7 days: restore the branch,
  `DB_SPLIT_MODE=single`.
- Load check on test.gokesari.com (every seller-table read now crosses
  postgres_fdw).

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
| Overlay tool, test layout, CI job `test-split` (non-blocking) | done |
| Full suite on the overlay | 850 failures → fixes above → re-run in progress |
| Split-aware migrations (`-- split:` tag, runner, self-repair; tested in `tests/integration/split-migrate.test.ts`) | done |
| Site cut-over script | to do |
| test.gokesari.com cut-over | — |
| gokesari.com cut-over (owner window) | — |
