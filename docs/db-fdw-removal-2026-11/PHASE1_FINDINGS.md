# FDW removal: Phase 1 findings and migration plan

02-Nov-2026 23.17 IST. Read-only investigation. Nothing has been changed on either Neon project.

## 1. What is there today

| | TEST `GoKesari-test-sg` (curly-night-16641982) | PROD `GoKesari-prod-sg` (lively-frost-99365966) |
|---|---|---|
| Endpoint | ep-hidden-star-b3k0l6ih (c-4, Singapore), always on | ep-calm-salad-ao1homrr (c-2, Singapore), always on |
| Databases | neondb (54 MB), gokesari_seller (60 MB), gokesari_customer (19 MB), neondb_test (11 MB), Test_Shop_owners (8 MB) | neondb (37 MB), `PROD_SELLER_DATABASE_URL` (34 MB), `PROD_CUSTOMER_DATABASE_URL` (15 MB) |
| neondb schemas | public, pmd, drizzle, backup_categorise_20261003121813, backup_pre0051_20261006 | public, pmd, drizzle |
| neondb → seller | server `gk_seller` → **its own endpoint**, dbname=gokesari_seller, fetch_size=1000 | server `gk_seller` → **its own endpoint**, dbname=PROD_SELLER_DATABASE_URL, fetch_size=1000 |
| Foreign tables in neondb | 174 (145 in `public`, 29 in `pmd` incl. 2 views) | 174, same list |
| Seller → core (reverse link) | server `gk_core` → neondb, 8 foreign tables: users, orders, platform_settings, roles, user_role_grants, status_changes, status_transition_rules, audit_logs | same |
| Seller DB contents | 281 tables (173 + 108 partitions of `pmd.price_history`), 2 views, 28 sequences, 20 triggers, ~28.5k rows | 281 tables, 14 shops, 46 products, 0 product-master rows, ~760 rows |
| Transfer this month (Neon) | 5.04 GB | 0.08 GB |

Full foreign-table list with remote schema/table and column counts: query output kept in the session. All 174 are `schema_name=<same>, table_name=<same>`; the largest are `shops` (108 cols), `pmd.v_product_flat` (74), `pmd.product_master` (63), `shop_registration_drafts` (52), `dealers` (49), `products` (41).

### Corrections to the brief

1. **The prod FDW dbname is not a placeholder.** A database literally named `PROD_SELLER_DATABASE_URL` exists on prod-sg (created 28 Oct, likely from a secret name pasted as the db name), and so does `PROD_CUSTOMER_DATABASE_URL`. The FDW works: `select count(*) from shops` through it returns 14. No prod page should be failing because of it. The fix is still needed (the name is misleading) and the migration removes it.
2. **Both `gk_seller` hosts are the project's own endpoint.** The traffic leaves the compute, goes through the public Neon proxy and comes back to the same compute. That round-trip is billed as transfer.
3. **There is a second loop in the other direction** (`gk_core` from the seller DB back to neondb), used by seller-side triggers (`record_lifecycle_change`, `inv_ledger_on_movement`) and lifecycle checks.

## 2. Why test burns 5 GB

`pg_stat_statements` on test since 30-Oct 10.10 UTC (seller DB side):

| Remote statement (sent by postgres_fdw) | Calls |
|---|---|
| `SELECT status FROM public.shops WHERE id = $1` (two variants) | 216,209 |
| `SELECT id, owner_id, name, … (all 108 columns) FROM public.shops …` (three variants) | 231,019 |
| `geo_areas WHERE code = …` | 17,660 |
| `shop_product_categories` lookups / full scans | 17,260 |
| `FETCH 1000 FROM c1` total | 598,122 calls, 7.17M rows |
| `FETCH 1000 FROM c2` / `c3` | 1.58M / 0.13M rows |

The site itself holds 10 postgres.js connections to neondb on test; the FDW holds 10 more into gokesari_seller. Driving load: the Hostinger crontab calls `/api/cron/every-minute` every minute on both sites (timeout sweep, notification retry, broadcast dispatch, integration sync, pmd-ingest), plus the hourly/daily jobs, the k6 load tests and Playwright runs against test (by hand), and the weekly QA run. Each shop-status check, trigger and join becomes a remote cursor round-trip. A full `shops` row is ~108 columns, so the 231k full-row fetches alone are a few GB.

Once the tables are local, none of this is network traffic. What stays is Hostinger ↔ Neon traffic for real page requests (prod is ~80 MB this month), so the target of under 1 GB/month is realistic.

## 3. Codebase references (summary)

- **Runtime:** one drizzle/postgres.js pool (`src/server/db/index.ts`, max `DATABASE_POOL_MAX`, default 10). It is cached on `globalThis` **only outside production**. The product-master code (`src/server/pmd/db.ts`, `appSql()`) keeps two more pools (core + seller, max 5 each). It is the only app code that connects to the seller DB directly, and only when `DB_SPLIT_MODE=split`.
- **The app already supports the single-database layout** (`DB_SPLIT_MODE=single` is the default, and the normal CI job runs on one database). With `DB_SPLIT_MODE` unset and the seller tables local in neondb, the site runs unchanged: same table names, same SQL.
- **Split-only machinery:** `src/server/db/split/*` (`upsertRow`, `touchSellerRow`, `integrity.ts`, `overlay.ts`, `switch.ts`, `tools.ts`), the 40001 retry wrapper in `db/index.ts`, `scripts/split-migrate.mjs` (re-imports foreign tables after every seller-tagged migration and rebuilds `gk_core`), `scripts/migrate-on-build.mjs` and `src/server/db/migrate.ts` (second client when split), `scripts/db-split/*`, `scripts/db-region-move/relink.sh`. Both migration runners pick split mode **by detecting `gk_seller` foreign tables**, so once those are gone they fall back to plain drizzle `migrate()` automatically.
- **CI and workflows:** `ci.yml` job `test-split` (blocking), `test-db.yml` (daily 02:17 IST; dumps the seller DB when split), `prod-db.yml` and `db-split.yml` (use `TEST_/PROD_SELLER_DATABASE_URL` secrets).
- **Tests:** about 12 unit/integration tests and helpers check or build the split layout (`db-split*.test.ts`, `split-migrate*.test.ts`, `transaction-retry.test.ts`, `pmd-db-url.test.ts`, `tests/helpers/pmd.ts`, …).
- **Docs:** CLAUDE.md (the "Two databases" section and Hostinger env rule), DEPLOYMENT.md, `docs/db-split-2026-10/*`, `docs/db-region-move-2026-10/PLAN.md`.
- **Mobile apps:** WebView shells pointing at gokesari.com or test.gokesari.com. They have no DB, endpoint or response-shape dependency, so no app rebuild is needed for this change.

## 4. Name clashes

- **neondb `public`/`pmd`:** none. The foreign tables hold the names, and no local table shares them.
- **Test backup schemas:** `backup_pre0051_20261006.shops` and `backup_categorise_20261003121813.{products, product_categories, product_subcategories, shop_product_categories}`. Harmless (different schema), but worth removing later.
- **Functions:** every seller-side `public` function already exists in neondb with the same signature. The 4 `pmd` functions (`touch_updated_at`, `claim_job`, `refresh_dashboard`, `ensure_price_history_partitions`) do not exist in neondb and must come across.
- **Sequences:** neondb already has the 28 matching sequences (created by `refreshForeignTables`). They must be set to the seller-side values at cut-over.
- **In flight:** PR #325 (dealer tiered commission, paused session) adds seller tables (`dealer_tier_shop_plans`, `dealer_team_*`, `shop_referral_codes`, `shop_referrals`) in migrations 0136/0137, not yet applied to test. Land it before the cut-over or after; not during.

## 5. Proposed plan. **Decision needed: target schema**

**Option A (recommended): seller tables become ordinary tables in neondb under their current names (`public.shops`, `pmd.product_master`, …).**
- Zero SQL or ORM changes. The app runs as `DB_SPLIT_MODE=single`, which CI already tests.
- The drizzle schema, raw SQL, triggers and the `pmd` schema keep working as they are.
- The seller/customer split stays as a logical label in `ownership.ts`, so it can be redone later if ever needed.

**Option B (as briefed): a new `seller` schema.**
- ~150 drizzle table definitions move to `pgSchema("seller")`, and every raw SQL string that names a seller table changes. `pmd.*` would need a decision of its own (it is already a schema).
- `search_path = public, seller` is not a safe shortcut. Neon's pooler runs in transaction mode, unqualified names in triggers resolve differently, and drizzle-kit would generate the next migration into `public`.
- Roughly 1–2 weeks of change and retest across the 798-case suite for the same network result as A.

Both options remove the FDW and the second database equally, so the network saving is the same.

### Phase 2 (test), with option A
1. Create Neon branch `pre-fdw-removal-2026-11-02` on test.
2. Pause the test crontab and run with the staging site in maintenance (about 15 min write freeze).
3. `pg_dump` from gokesari_seller: schemas `public` + `pmd`, **seller tables only** (excluding the 8 `gk_core` foreign tables and `drizzle`), plus the 4 pmd functions, triggers, indexes, constraints and grants. Restore it into a staging schema in neondb (`seller_import`, plus `pmd_import` for pmd). This step is non-destructive.
4. Compare row counts table by table (seller DB vs import) and print the table.
5. **Cut-over transaction (needs your "yes"; shown as exact SQL first):** for each of the 174 tables, `DROP FOREIGN TABLE` + `ALTER TABLE seller_import.x SET SCHEMA public` (pmd likewise). Re-point the identity defaults to the local sequences and `setval` each to `max(id)`. Re-create cross-table FKs only where both ends were core-side before (no new seller↔customer FKs, matching today).
6. Hostinger test env: unset `DB_SPLIT_MODE` and `SELLER_DATABASE_URL`. Redeploy, run the full suite (CI + QA guest and signed-in tiers on test).
7. **After your approval:** `DROP SERVER gk_seller CASCADE`, `DROP EXTENSION postgres_fdw` in neondb. In gokesari_seller, `DROP SERVER gk_core CASCADE`. Keep gokesari_seller 7 days, then drop it.
8. Code clean-up PR:
   - remove the seller pool from `pmd/db.ts`
   - retire `test-split`, `db-split.yml` and the split branches of the migrators, `test-db.yml` and `prod-db.yml`
   - keep `ownership.ts` as documentation
   - update CLAUDE.md, DEPLOYMENT.md and the decision log
   - load-reduce the every-minute cron (skip work when there is nothing queued)

### Phase 3 (prod)
Same steps after test sign-off, in a low-traffic window, one release at a time per DEPLOYMENT.md §3. The `PROD_SELLER_DATABASE_URL` and `PROD_CUSTOMER_DATABASE_URL` databases and secrets are removed after 7 days, so no placeholder-named config remains.

### Phase 4 (query efficiency)
- Cache the drizzle pool on `globalThis` in production too, and set `DATABASE_POOL_MAX=5`.
- Collapse the pmd pools into the same client.
- Then trim `/api/shops`, `/shops/nearby` and the product APIs: needed columns only, `LIMIT`, distance filter in SQL, `revalidate` 60–300 s.

### Rollback (each project)
Reset the branch to `pre-fdw-removal-2026-11-02`, restore the previous Hostinger env (`DB_SPLIT_MODE=split`, `SELLER_DATABASE_URL`), and redeploy the previous build. gokesari_seller / `PROD_SELLER_DATABASE_URL` stay untouched for 7 days, so a reset gives back the exact pre-move layout.

## 6. Phase 2 progress (test): option A chosen 02-Nov-2026

- Backup branch `pre-fdw-removal-2026-11-02` (br-autumn-term-b307q60t) created on test from main.
- Dry run on scratch branch `fdw-removal-dryrun-2026-11-02` (br-tiny-unit-b3w4jcs2): passed.
  - One transaction ([scripts/db-fdw-removal/cutover.sql](../../scripts/db-fdw-removal/cutover.sql)), 2 min 43 s.
  - 174/174 tables and 30,916/30,916 rows match ([test_dryrun_row_counts.csv](test_dryrun_row_counts.csv)).
  - 0 foreign tables left in public/pmd, and no server named `gk_seller` remains.
  - 29 triggers and 866 foreign keys in place.
  - Sequences sit past every value already used (next product code P01231 after P01230).
  - A shop update fires the lifecycle trigger and writes `status_changes` locally.
- What the cut-over does: it moves (not drops) the 174 foreign tables to `fdw_old_public` / `fdw_old_pmd` and renames the server to `gk_seller_retired`. Then it creates the seller tables from a schema-only dump of the seller database, copies the rows, adds keys, indexes and triggers, and sets the sequences. No DROP, DELETE or TRUNCATE. The seller database is not touched.
- Found during the dry run: 5 trigger functions in neondb were older than the seller copies, because seller-only migrations 0095, 0097, 0109, 0113, 0118 and 0120 updated them only there (`inv_ledger_on_*`, `shop_kyc_complete`, `shop_sells_food`). The cut-over installs the seller versions.

### Out of scope here
Deleting the Neon project **bkesari-agtci** belongs to the Bkesari chat (this repository's chats are GoKesari-only). The old US projects GoKesari-prod and GoKesari-test can be deleted from here once you say so.
