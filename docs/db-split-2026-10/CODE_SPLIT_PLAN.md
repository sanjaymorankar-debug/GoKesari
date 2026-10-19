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
| 6 | postgres_fdw runs the seller side at **REPEATABLE READ** (one snapshot per transaction): two requests changing the same seller row get "could not serialize access" (40001) instead of a wait, and a transaction that waited for a row lock still reads other rows as they were before the wait (found by the full run: five registrations racing for a referral code's last slot let three through) | in split mode a top-level transaction runs at **SERIALIZABLE** (so does its seller side), PostgreSQL stops every such race with 40001, and the transaction is run again from the start (also on a deadlock, 40P01); savepoints that swallow errors rethrow 40001 |
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

- Load check on test.gokesari.com (every seller-table read now crosses
  postgres_fdw; each site connection that uses a seller table opens one
  connection of its own to the seller database).

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
| Overlay tool, test layout, CI job `test-split` | done — blocking from 19 Oct |
| Full suite on the overlay | 850 failures → 56 → 1 (the referral race, item 6) → **all pass** (CI, 19 Oct) |
| Split-aware migrations (`-- split:` tag, runner, self-repair; tested in `tests/integration/split-migrate.test.ts`) | done |
| Switch and switch back for a site (`scripts/db-split/switch.ts`, workflow actions; tested in `tests/integration/db-split-switch.test.ts`, including writes during the switch) | done |
| test.gokesari.com switch | — |
| gokesari.com switch (owner window) | — |

## 5. Switching a site (runbook)

The switch is one step on the database. The site needs no setting changed at
that moment: with `DB_SPLIT_MODE=split` it looks at its database (every 30 s)
and uses the seller database directly for the product master only once the
switch has happened; until then it keeps using `DATABASE_URL` alone.

**Before (once per site)**

1. This release is deployed to the site (the check refuses while the site's
   database has migrations still to apply).
2. Hostinger → the site → environment variables: add `DB_SPLIT_MODE` =
   `split` and `SELLER_DATABASE_URL` = the seller database's connection string
   (the same value as the GitHub secret `TEST_SELLER_DATABASE_URL` /
   `PROD_SELLER_DATABASE_URL`). Redeploy. Safe before the switch, as above.

**Switch** (Actions → **Database split** → Run workflow)

3. `switch-status` (expect *single*) and `switch-check` (expect *Ready*). The
   check is read-only; it also tries the link both ways through postgres_fdw
   and rolls it back, so an unreachable database or a wrong password shows up
   here.
4. `switch` — test: branch `staging`, target `test`. Production: branch
   `main`, target `production`, confirm `SPLIT PRODUCTION`; refused until the
   test site is switched. What it does, in one transaction on the site's
   database:
   - pauses writes to the seller tables (reads go on; a write waits, then
     lands in the seller database — none is lost);
   - empties the seller database, builds it from the migrations and copies
     every seller row; row counts and checksums must match;
   - links the two databases, parks the site's own seller tables (schema
     `split_parked`, `split_parked_pmd`) and puts foreign tables of the same
     names in their place;
   - reads every seller table back through the link before it commits.
   If any step fails, nothing changes. Writes wait at most 10 minutes: past
   that the switch stops by itself and rolls back; the database also cancels
   any one statement of it that runs over 5 minutes, and ends it if its
   client goes silent for a minute — so a stalled or lost run can never keep
   the site's writes waiting.
5. Smoke and signed-in journeys on the site (`tests/e2e`), and the payment
   test with Cashfree sandbox data on test.gokesari.com only.

**Undo**

- `switch-back-check`, then `switch-back` — set `DB_SPLIT_MODE` = `single` on
  Hostinger first (and redeploy), so nothing writes to the seller database
  directly while it is copied back. Every row written since the switch is
  kept; the foreign keys between seller and customer tables come back (any
  that rows written meanwhile break are kept for new rows and listed). It works
  until a migration changes a seller table, or until `drop-parked`.
- Last resort: Neon console → the project → Restore → to the time in the
  switch run's summary (loses what was written after it).

**After the switch:** the product-master tools (`npm run pmd:*`, which never
fall back to the site's database) take `PMD_DATABASE_URL` = the seller
database.

**After the rollback window (7 days):** `drop-parked` frees the parked copy.

Backups (`test-db.yml` → backup) include the seller database once a site is
switched, and the migration workflows pass `SELLER_DATABASE_URL` to the runner.
