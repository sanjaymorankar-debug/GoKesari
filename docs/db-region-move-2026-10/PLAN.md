# Move the GoKesari databases to Neon Singapore (aws-ap-southeast-1)

Plan, 28 Oct 2026. Status: **part A done (28 Oct 2026); nothing frozen or moved**. Needs the owner's approval
before each site moves (production in an owner-approved window).

## Why

The app runs on Hostinger in **Mumbai**. Both Neon projects are in **AWS us-east-2
(Ohio)**. Every query makes a round trip of about 200–250 ms.
- **Home page:** about 8 queries in a row, about 1.9 s.
- **Approving a seller document:** several dozen queries, 5–15 s.

Neon has no Mumbai region for this account (checked 28 Oct 2026); the owner chose
**Singapore** (`aws-ap-southeast-1`), the nearest. From Mumbai each round trip is
about 55–65 ms instead of ~230 ms: roughly 3–4× faster (home page ~0.5 s,
approval ~2–4 s). Moving approval follow-ups out of the request is still worth
doing after the move. Diagnosis:
`Doc_GoKesari/Devlopment_Trackers/GOKESARI_PERFORMANCE_DIAGNOSIS_2026-10-28.md`.

## What is being moved (measured 28 Oct 2026)

| Neon project | Region now | Databases (size) |
|---|---|---|
| `GoKesari-test` (weathered-cloud-85449869) | us-east-2 | `neondb` 80 MB (core), `gokesari_seller` 64 MB, `gokesari_customer` 24 MB (unused), `neondb_test` 11 MB, `Test_Shop_owners` 7.5 MB |
| `GoKesari-prod` (sparkling-scene-39325894) | us-east-2 | `neondb` 44 MB (core), `PROD_SELLER_DATABASE_URL` 38 MB (seller; the database really has this name), `PROD_CUSTOMER_DATABASE_URL` 20 MB (unused) |

Facts that shape the plan:
- **PostgreSQL 18.** The new projects must also be 18, and the dump/restore client must be 18.
- **Extensions:** `plpgsql`, `pg_trgm`, `btree_gin`, `postgres_fdw`. Add `pg_stat_statements` in the new projects.
- **Role:** one login role, `neondb_owner`, used by the app.
- **Both sites are on the split layout.**
  - The core database has foreign server `gk_seller` → the seller database in the **same Neon project**, with a user mapping for `neondb_owner` (user + password).
  - Production has 141 foreign tables (`public`, `pmd`).
  - The parked copies (`split_parked`: 111 tables, `split_parked_pmd`: 136 tables) still exist, so `switch-back` remains possible.
- **`neon_auth` schema (9 tables):** created by Neon, not used by the app code (no reference in `src/`). Not copied.
- **Region:** a Neon project's region cannot be changed. The move means new projects plus a copy of the data.
- **Deploys run migrations:** every Hostinger build runs `scripts/migrate-on-build.mjs` against `DATABASE_URL` when `MIGRATE_ON_BUILD=true`. On a read-only database that step fails and the build stops. During the move it is switched off (step C4).
- **Total data is about 100 MB per site.** A dump/restore is minutes, so logical replication (zero downtime, but sequences, the FDW and two databases make it fiddly) is not worth it.

## Method in one paragraph

Make the old databases **read-only**: the site keeps showing pages, and anything that writes (checkout, sign-up, approvals) fails until the end. Then:
1. Dump the databases and restore them into a new Singapore project.
2. Re-point the `gk_seller` link to the new seller database.
3. Compare row counts.
4. Point Hostinger at the new database **while it is still read-only**, and smoke-test the site.
5. Only then open the new database for writes.

Until that last step, the old database is untouched and is the rollback.

## Downtime estimate

| Step | Staging | Production |
|---|---|---|
| Freeze (read-only + drop app connections) | 1 min | 1 min |
| Dump core + seller | 1–2 min | 1–2 min |
| Restore into Singapore (parallel, `-j 8`) | 3–8 min | 3–6 min |
| Fix the `gk_seller` link, compare row counts | 3–5 min | 3–5 min |
| Hostinger env change + redeploy (build ~4 min, restart ~15 s) | 5–6 min | 5–6 min |
| Smoke test on the new database, still read-only | 5 min | 5 min |
| **Read-only window (pages work, writes fail)** | **~20–30 min** | **~20–30 min** |
| **Full outage** (app restart at the end of the redeploy) | ~15–60 s | ~15–60 s |
| Rollback before writes are opened (one more redeploy) | +6 min read-only | +6 min read-only |

The staging run and the production rehearsal (step B) give the real figures. If the restore takes much longer than 10 minutes, run it from a machine in India (see the note in step C5).

Production window: a low-traffic time, e.g. **02:00–04:00 IST**, with no release in flight (CLAUDE.md "Production releases").

Effects during the read-only window:
- New orders and payments cannot be placed.
- Cashfree webhooks fail and Cashfree retries them later; check them afterwards (step D4).
- Cron calls fail and the next run catches up.

---

## A. Prepare (once, no impact on either site)

Status 28 Oct 2026: steps 1–4 **done**; step 5 and the workflow action are still open.

1. **Done: new Neon projects** in `aws-ap-southeast-1` (Singapore), PostgreSQL 18.6:
   - **`GoKesari-test-sg`**: project `curly-night-16641982`, branch `br-lively-grass-b3rr52ez`;
   - **`GoKesari-prod-sg`**: project `lively-frost-99365966`, branch `br-wispy-water-aoyyoxiv`;
   - autoscaling 0.25–2 CU and 6 h history, as today.
   - Before production goes live on it, consider min 0.5 CU and scale-to-zero **off** (no cold start after quiet spells).
2. **Done: databases with the same names** as today, owned by `neondb_owner`:
   - test: `neondb`, `gokesari_seller`, `gokesari_customer`, `neondb_test`, `Test_Shop_owners`;
   - prod: `neondb`, `PROD_SELLER_DATABASE_URL`, `PROD_CUSTOMER_DATABASE_URL`.

   Keeping the names means nothing in the code, the FDW server or the scripts changes except the host and password. All are empty.
3. **Done: extensions** in every new database: `pg_trgm`, `btree_gin`, `postgres_fdw`, plus `pg_stat_statements` (new: lets slow queries be listed).
4. **Done: tooling in `scripts/db-region-move/`.** URLs are passed in the environment, so passwords stay out of the process list. Only host and database names are printed.
   - **`copy.sh`** — `SRC_URL=<old> DST_URL=<new> [REQUIRE_FROZEN=yes] [JOBS=8]`. Copies one database: `pg_dump -Fc --no-owner --no-privileges`, without `neon_auth` and without the extensions (the target has its own); then `pg_restore -j 8 --exit-on-error`, then `analyze`. It refuses when:
     - source and target are the same server;
     - the PostgreSQL versions or the database names differ;
     - the target already holds tables;
     - the target lacks an extension;
     - the target is read-only;
     - with `REQUIRE_FROZEN=yes`, the source is still writable.
   - **`relink.sh`** — `CORE_URL=<new core> SELLER_URL=<new seller>`. Sets `gk_seller`'s host, port and database and the user mapping's user and password from the seller URL. It creates the mapping if the dump lacked it. It then checks:
     - the link carries exactly those values;
     - `shops` reads through it with the same count as in the seller database directly.

     It refuses on a database without `gk_seller`. Safe to run twice.
   - **`compare.sh`** — `OLD_URL=<old> NEW_URL=<new> [FOREIGN=no]`. Compares, in one statement per side:
     - the exact row count of every table, including foreign tables, which read through each side's own link;
     - every sequence's last value;
     - per schema, the number of tables, indexes, constraints, triggers, functions and views;
     - the extensions and the foreign server.

     It prints differences and exits 1 on any. Read-only.
   - **Tested 28 Oct 2026** on two throwaway local PostgreSQL 18 clusters built like the split layout: core with a partitioned table, view, `drizzle`, `split_parked`, `neon_auth` and foreign tables in `public` and `pmd`; seller with a trigram index, a trigger, an identity column and a cross-schema foreign key. Results:
     - copy, relink and compare all passed;
     - every refusal fired;
     - a frozen source copied cleanly;
     - a deleted row and a moved sequence were reported, including the deleted seller row seen through the core's link.

     Not yet run against Neon: that is rehearsal step B.
5. **Open: new GitHub secrets**, added next to the old ones (not replacing them yet): `TEST_DATABASE_URL_SG`, `TEST_SELLER_DATABASE_URL_SG`, `PROD_DATABASE_URL_SG`, `PROD_SELLER_DATABASE_URL_SG`. Each is a **direct** (non-pooler) connection string with `sslmode=require`, from the Neon console → the project → Connect.
6. **Open (optional): a `region-move` workflow action** that runs freeze → copy → relink → compare from GitHub with a confirm word. Running the scripts from the owner's Mac is closer to Singapore and is the default; the Mac has the PostgreSQL 18.6 client.

## B. Rehearsal on production data (no impact: it only reads)

1. Run `copy.sh` from the **production** databases into `GoKesari-prod-sg` **without** freezing, then `relink.sh` and `compare.sh`. Counts may differ slightly because production keeps writing; that is expected here.
2. Note the time each step took. That is the production downtime estimate.
3. Point a **local** build at the Singapore copy (`DATABASE_URL` + `SELLER_DATABASE_URL`, `DB_SPLIT_MODE=split`) and open `/`, `/shops` and the admin pages. Check that they read through the `gk_seller` link.
4. Empty the Singapore databases again (drop and recreate the three databases from A2/A3) so the real copy starts clean. No production data may be left in a project nobody watches.

## C. Move staging (test.gokesari.com) first

1. **Before:**
   - Check that no deploy to test.gokesari.com is running.
   - Run "Test database → backup" (artifact kept 14 days).
   - Run "Database split → `switch-status`", target test: expect *split*.
2. **Freeze the old test databases** (as `neondb_owner` on the old project):
   ```sql
   alter database neondb set default_transaction_read_only = on;
   alter database gokesari_seller set default_transaction_read_only = on;
   select pg_terminate_backend(pid) from pg_stat_activity
    where datname in ('neondb','gokesari_seller') and usename = 'neondb_owner' and pid <> pg_backend_pid();
   ```
   The app reconnects automatically and is now read-only.
3. Note the time (UTC). This is the start of the window.
4. **Hostinger (test site) → environment variables:** set `MIGRATE_ON_BUILD=false` for now. Leave the rest as is.
5. **Copy:** `copy.sh` for `gokesari_seller` first, then `neondb`. Also copy `neondb_test`, `Test_Shop_owners` and `gokesari_customer`, so the old project can be retired.

   If the restore over the Ohio→Singapore distance is slow (thousands of DDL statements, each a round trip), run it from the owner's Mac (India, ~60 ms to Singapore) rather than a US GitHub runner. Keep `-j 8` either way.
6. **Relink** on the new `neondb` (the dump brought over the old host and the old password):
   ```sql
   alter server gk_seller options (set host '<new Singapore endpoint host>');
   alter user mapping for neondb_owner server gk_seller options (set password '<new neondb_owner password>');
   ```
   If the user mapping did not come across, use `create user mapping for neondb_owner server gk_seller options (user 'neondb_owner', password '...')`. Then check: `select count(*) from shops; select count(*) from pmd.<any table>;` must work through the link.
7. **Compare:** `compare.sh old new` for `neondb` and for `gokesari_seller`. All counts and sequences must be equal. If not, stop: go to **Rollback R1**.
8. **Freeze the new copy too** (same `alter database … read_only = on` on the new project). This lets the site be tested on it without anyone writing yet.
9. **Hostinger (test site):**
   - `DATABASE_URL` = new core URL, `SELLER_DATABASE_URL` = new seller URL. Keep `DB_SPLIT_MODE=split`.
   - Also update `PMD_DATABASE_URL` and `CUSTOMER_DATABASE_URL` if they are set there.
   - Redeploy, and wait for "Deployment completed".
10. **Smoke test (read-only):**
    - `scripts/release/post-deploy-check.sh https://test.gokesari.com`;
    - the guest QA tier (`gokesari-qa-run`, guest);
    - home-page time to first byte: expect well under 0.5 s.
    - "Database split → `switch-status`" with the **new** secrets: expect *split*.

    Writes will fail here; that is expected.
11. **Go / no-go.**
    - Go: on the new project, run `alter database neondb reset default_transaction_read_only; alter database gokesari_seller reset default_transaction_read_only;` then restart the app (hPanel or `hosting_nodejs_restart-application`) so every connection picks it up.
    - No-go: **Rollback R1**.
12. **After go:**
    - Signed-in QA tier.
    - An approval: approve a seller document as admin and time it.
    - A Cashfree **sandbox** payment through the "Sandbox payment" workflow (test data from `docs/testing/cashfree-sandbox-test-data.md`).
    - Set `MIGRATE_ON_BUILD=true` again (redeploy).
    - Point the GitHub secrets `TEST_DATABASE_URL` and `TEST_SELLER_DATABASE_URL` (and `TEST_CUSTOMER_DATABASE_URL`) at the new project.
    - Run "Test database → verify" and "→ backup".
13. **Keep the old test project read-only for 7 days**, then delete it (owner confirms).

## D. Move production (gokesari.com), only after staging has run cleanly for a few days

Same steps as C, with production names:
- databases `neondb` and `PROD_SELLER_DATABASE_URL`, plus `PROD_CUSTOMER_DATABASE_URL`;
- secrets `PROD_*`;
- **no payment tests** (never sandbox data on gokesari.com).

Extra rules:
1. **Before:**
   - Owner approves the window.
   - No open staging → main PR and no Hostinger build running.
   - A fresh backup of both databases.
   - Also note the Neon restore point: the time of the freeze.
2. **During:** nobody merges into `main`. A deploy would run against whichever database the env points at.
3. **After go:**
   - Run "Post-deploy check" (or the script) and the guest QA tier.
   - Restore `MIGRATE_ON_BUILD`.
   - Update the `PROD_*` secrets, so "Production database → verify" and the backups now read Singapore.
4. **Cashfree:** check that payments and webhooks from the window were received. Compare Cashfree's dashboard with orders for the window; the payment reconciliation job catches any that are missing.
5. **Old production project:**
   - keep it read-only for **14 days**;
   - export a final `pg_dump` of it to the owner's backups;
   - delete it only on the owner's word.
6. **Update the docs:**
   - DEPLOYMENT.md (database location);
   - `docs/db-split-2026-10/CODE_SPLIT_PLAN.md` (`gk_seller` host);
   - CLAUDE.md "Two databases" if it names hosts.

## Rollback

- **R1. Before the new database is opened for writes** (anything in C2–C11 / D): no data can be lost, because nothing was written anywhere.
  1. Put the old URLs back on Hostinger (with `MIGRATE_ON_BUILD` as it was) and redeploy.
  2. Lift the freeze on the old databases: `alter database … reset default_transaction_read_only`, then restart the app.

  About 6 minutes. If Hostinger was never changed, just lift the freeze and restart.
- **R2. After writes are opened on Singapore** (a problem found later): the old database is missing everything written since. Do the same procedure the other way round:
  1. freeze Singapore;
  2. `copy.sh` Singapore → a **fresh** database in the old project (the old one is kept as a fallback);
  3. relink, compare, switch Hostinger back, open writes.

  The same ~20–30 min read-only window applies. Data is kept.
- **R3. Last resort:** Neon point-in-time restore on the old project to the freeze time. Everything written on Singapore after go is lost, so use it only if R2 is impossible.

## What does not change

- No code change is needed for the move itself. The scripts in A4 are new tooling.
- No migration is needed.
- The split layout, `DB_SPLIT_MODE`, table names and database names stay as they are. Only hosts and passwords change.
- `switch-back` keeps working, because the parked schemas are copied too. If the 7-day rollback window of the split is over, run `drop-parked` **before** the move to make the copy smaller.

## Checklist for the owner

- [x] Approve creating the two Singapore Neon projects (done 28 Oct 2026).
- [ ] Approve the staging move (any time).
- [ ] Approve the production window (date and time, IST).
- [ ] Confirm the old projects may be deleted after 7 days (test) / 14 days (production).
