# Move the GoKesari databases to Neon Singapore (aws-ap-southeast-1)

Plan, 28 Oct 2026. Status: **done: both sites moved to Singapore on 28 Oct 2026.** test.gokesari.com (part C) and gokesari.com (part D). Old Ohio projects kept frozen as fallback.
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
| Copy core + seller from the owner's Mac, the two at once (measured in B: seller 4.4 min, core 6.3 min, one after the other) | ~7–9 min | ~6.5 min |
| Relink + compare both (measured: 2 s + 24 s) | 1–2 min | 1 min |
| Hostinger env change + redeploy (build ~4 min, restart ~15 s) | 5–6 min | 5–6 min |
| Smoke test on the new database, still read-only | 5 min | 5 min |
| **Read-only window (pages work, writes fail)** | **~20–25 min** | **~20–25 min** |
| **Full outage** (app restart at the end of the redeploy) | ~15–60 s | ~15–60 s |
| Rollback before writes are opened (one more redeploy) | +6 min read-only | +6 min read-only |

Rehearsal B measured the copy (see its results). Most of the copy time is `pg_dump` asking Ohio
for the catalogue one query at a time: 278 ms per round trip from the Mac. Run the seller and core
copies **at the same time** (two terminals) to bring 10.7 min down to about 6.5. A dump taken from
a US machine would take seconds, but the restore must then come from India.

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

**Done 28 Oct 2026, 10:10–10:34 UTC.** Run from the owner's Mac (India), not frozen, into
`GoKesari-prod-sg`. Then emptied again: `neondb` and `PROD_SELLER_DATABASE_URL` dropped and
recreated with the extensions, no foreign server or user mapping left. Neon keeps 6 h of history
of that project, so the copy can be restored from it until about 16:35 UTC on 28 Oct.

| Step | Time | Result |
|---|---|---|
| Round trip per query from the Mac | Ohio 278 ms, Singapore 71 ms | about 4× shorter |
| `copy.sh` seller (`PROD_SELLER_DATABASE_URL`, 2.2 MB dump) | 265 s (dump 166, restore 91) | ok |
| `copy.sh` core (`neondb`, 1.9 MB dump) | 377 s (dump 256, restore 114) | ok |
| Before relink | — | the new core's `gk_seller` still pointed at the **Ohio** seller: the relink step is essential |
| `relink.sh` | 2 s | `gk_seller` → Singapore seller, 13 shops read through the link |
| `compare.sh` seller | 15 s | **same**: 257 tables, 730 rows, 29 sequences, all objects |
| `compare.sh` core | 9 s | **same**: 520 tables (incl. 141 foreign, read through the link), 1,866 rows, 52 sequences, all objects |
| `switch.ts status` on the copy | — | `split`, parked copy present, as production |
| 8 home-page-like queries (core + seller through the link), from the Mac | Ohio 2.3 s, Singapore 0.72 s | 3.2× faster |

Findings:
- Fixed in `copy.sh`: the "target must be empty" check counted the views of `pg_stat_statements`. Extension objects are now ignored.
- The app was **not** started against the copy. With production data, its delivery timer and cron would send real e-mails, SMS and push to real customers. The app is checked on staging (C10) instead, where the data is test data.
- `switch.ts check-back` says the **split cannot be switched back any more**: migrations changed seller tables since the switch. The copy matches production on this, so it is an existing state, not caused by the move. The plan does not rely on it: rollback is R1/R2/R3 below.

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
5. **Copy** with `REQUIRE_FROZEN=yes`, from the owner's Mac, the two databases **at the same time** in two terminals: `copy.sh` for `gokesari_seller` and for `neondb`. Neither needs the other: the link is fixed afterwards in step 6. Copy `neondb_test`, `Test_Shop_owners` and `gokesari_customer` **before** the freeze, to keep the window short. The site works on `neondb` + `gokesari_seller` only; check first whether anything still writes to the other three.

   Rehearsal B took 4.4 min (seller) and 6.3 min (core) one after the other, almost all of it `pg_dump` waiting on Ohio (278 ms per round trip).
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

### C — what happened, 28 Oct 2026 (test.gokesari.com)

| Time (UTC) | Step |
|---|---|
| 10:38–10:43 | Backup: `pg_dump` of all five old test databases, in parallel, 325 s (about 10 MB). The GitHub backup workflow could not be started: `gh` is not installed on the owner's Mac. |
| **10:43:53** | **Freeze.** All five old databases read-only (not only core + seller, so nothing could be missed); 15 app connections ended. |
| 10:44–10:51 | Copy of the five in parallel, `REQUIRE_FROZEN=yes`: seller 292 s, core 421 s, customer 126 s. `neondb_test` and `Test_Shop_owners` stopped on a script bug (below) and were copied after the fix: 76 s. |
| 10:52–10:55 | Relink: the new core's link still pointed at the Ohio seller, and was moved to the Singapore seller (30 shops through the link). Compare: **all five identical**. Core: 553 tables, 67,719 rows, 51 sequences. Seller: 277 / 31,785 / 29. Customer: 101 / 4,723 / 5. `neondb_test`: 54 / 16 / 4. `Test_Shop_owners`: empty. |
| 10:55:09 | Singapore copy frozen too; `switch.ts status` → `split`. |
| — | Owner set `DATABASE_URL`, `SELLER_DATABASE_URL` (Singapore, `?sslmode=require` only) and `MIGRATE_ON_BUILD=false` on Hostinger, then redeployed. |
| 11:55–12:08 | Read-only checks on the new database. **App connections only on Singapore, none on Ohio.** Home page 0.53–0.60 s (was 1.8–2.1 s). Post-deploy check 5/5 healthy. Guest QA: 85 pass, 8 fail, 3 blocked by the host firewall (E-01). None of the failures came from the move (see below). |
| **12:14:09** | **Writes opened** on Singapore. The app's 8 pre-reset connections were ended so the pool reconnected writable. A test write passed, including a seller table through the link. |
| 12:16 | TC-PAY-005 / TC-PAY-022 (they failed only because the database was read-only) **pass**. The app's webhook rows land in Singapore; none in Ohio since the freeze. |

**Read-only window: 1 h 30 min.** Of that, the database work took 11 min (10:43:53 → 10:55:09). The rest was waiting for the Hostinger change, the redeploy and the checks. For production, have the env values typed in hPanel before the freeze, and the owner at hand: the window should then be ~20–25 min.

The guest QA failures, none caused by the move:
- **Dealer pages and APIs answer 404** (TC-RBAC-002, TC-AUTH-033, TC-SEC-001). The redeployed build does not contain the dealer programme, though `staging` does. Redeploy `staging` (no migration is pending; the Singapore database already has 0107).
- **Retired cron routes answer 410** (TC-DSP-022, TC-SEC-001). This is intended (`src/proxy.ts`, `CRON_ROUTES_ENABLED`); the check should accept 410.
- **Webhook with a bad signature answered 500** (TC-PAY-005, TC-PAY-022). It saves a row first, which failed while read-only. It passed once writes were open.

Lessons, written into the steps for D:
1. **Script bugs found and fixed** (commit `41fd6ef`).
   - `copy.sh` stopped on a database without extensions: an empty array counts as unbound under `set -u` in macOS bash 3.2.
   - Worse: a failed run still **exited 0**. The EXIT trap's status replaced the error, so a failed copy looked successful.
   - Both scripts now count any exit before their last line as a failure.
2. **Lifting the freeze.** `alter database … reset default_transaction_read_only` must run from the `postgres` database, after `set default_transaction_read_only = off`. From a frozen database the session itself is read-only.
3. **After lifting the freeze**, end the app's connections that were opened before it (or restart the app). The connection pool keeps read-only sessions otherwise.
4. **Extensions must match.** Create in each new database only the extensions its old one has, plus `pg_stat_statements`. Otherwise compare reports the difference. On staging, `gokesari_customer`, `neondb_test` and `Test_Shop_owners` had none, and the extras were dropped before compare.
5. **No pushes during the window.** Another session pushed `staging` at 11:12 UTC, mid-window. It did no harm (no migration, the database was read-only), but a migration in it would have failed the build. For production: nobody merges into `main` and nobody pushes `staging` until writes are open.

Still to do for staging:
- [x] Owner: GitHub secrets `TEST_DATABASE_URL`, `TEST_SELLER_DATABASE_URL` and `TEST_CUSTOMER_DATABASE_URL` point at the Singapore project (done 28 Oct 2026).
- [ ] Owner: repository / `test` environment variable **`TEST_DATABASE_HOST`** → `ep-hidden-star-b3k0l6ih.c-4.ap-southeast-1.aws.neon.tech`. `scripts/test-db/guard.sh` compares the secret with it. Missed at first, so the "Test database" run for `bf53b23` stopped at its guard and migrations 0108–0110 did not reach the Singapore test database.
- [ ] Owner: `MIGRATE_ON_BUILD=true` on test.gokesari.com. Then re-run "Test database" → `migrate` (or redeploy the test site) to apply 0108–0110. To confirm: Actions → "Test database" → `verify`; its summary must name host `ep-hidden-star-b3k0l6ih.c-4.ap-southeast-1.aws.neon.tech`.
- [ ] Redeploy `staging` on Hostinger (dealer pages), with `MIGRATE_ON_BUILD=true`, then re-run TC-RBAC-002 / TC-AUTH-033.
- [ ] Keep the Ohio test project (`GoKesari-test`, frozen) until **4 Nov 2026**, then delete it on the owner's word.
- [ ] Backup dumps of the old test databases are only in the session scratchpad. Keep a copy elsewhere if wanted.

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

### D — what happened, 28 Oct 2026 (gokesari.com)

The owner asked for production straight after staging. That was safe because production had **no orders, no active subscriptions and 2 sign-ups in the last day**, so a read-only window affected nobody.
- **Release check:** no open PR into `main`; the last production deploy (27 Oct, `f7c0032`) passed its post-deploy check.
- **Migrations:** `main` and the production database both had 98 migrations, so the redeploy applied nothing.
- **Hostinger values:** given to the owner and typed into hPanel **before** the freeze.

| Time (UTC) | Step |
|---|---|
| 12:45–12:50 | Backup of the three production databases (`pg_dump`, parallel, 257 s, 4.7 MB) to the session scratchpad. |
| **12:50:33** | **Freeze**: `neondb`, `PROD_SELLER_DATABASE_URL` and `PROD_CUSTOMER_DATABASE_URL` read-only (set from the `postgres` database); 8 app connections ended. |
| 12:50–12:57 | Copy, three in parallel, `REQUIRE_FROZEN=yes`, 387 s: seller 268 s, core 380 s, customer 119 s. |
| 12:57 | **Relink**: the core's link moved from the Ohio seller to the Singapore seller (13 shops through the link). **Compare: all three identical.** Core: 520 tables, 1,866 rows, 52 sequences. Seller: 257 / 730 / 29. Customer: 107 / 460 / 5. |
| 12:57:54 | Singapore copy frozen; `switch.ts status` → `split`. |
| — | Owner saved `DATABASE_URL`, `SELLER_DATABASE_URL` (Singapore) and `MIGRATE_ON_BUILD=false`, and redeployed. |
| 13:13–13:21 | Read-only checks. **App connections only on Singapore (15), none on Ohio.** Home page 0.57–0.87 s (was 1.8–2.1 s), `/shops` 0.33 s. Post-deploy check 5/5. |
| **13:23:28** | **Writes opened.** Pre-reset app connections ended (pool reconnected writable); test write ok. |
| 13:24–13:28 | TC-PAY-005 / TC-PAY-022 pass. The app's audit rows land in Singapore, none in Ohio since the freeze. **Post-deploy check 5/5 after the writes opened.** |

**Read-only window: 32 min 55 s** (12:50:33 → 13:23:28), against 1 h 30 min on staging. Values prepared before the freeze saved most of the difference.

Guest QA on gokesari.com, latest result per check: **87 pass, 6 fail, 3 blocked, 1 skipped.** None of the failures came from the move:
- Dealer pages and APIs answer 404: the dealer programme is not released to production yet.
- Retired cron routes answer 410: intended; the check should accept 410.
- Search with `<script>` is blocked by Hostinger's firewall (E-01).

Still to do for production:
- [x] Owner: `MIGRATE_ON_BUILD=true` set again on gokesari.com (28 Oct); the rebuild it triggered passed the post-deploy check (5/5, 13:59 UTC).
- [x] Owner: `production` environment secrets and `PROD_DATABASE_HOST` updated to Singapore (28 Oct). Still to do: run "Production database" → `verify` once to prove them.
- [ ] (was) Owner: point the GitHub secrets `PROD_DATABASE_URL`, `PROD_SELLER_DATABASE_URL` and `PROD_CUSTOMER_DATABASE_URL` at `ep-calm-salad-ao1homrr.c-2.ap-southeast-1.aws.neon.tech` (same database names). If the repository variables `PROD_DATABASE_HOST` / `PROD_DATABASE_NAME` exist, update the host too: `scripts/prod-db/guard.sh` compares the secret with them. Then run "Production database → verify".
- [ ] Keep the Ohio production project (`GoKesari-prod`, frozen) until **11 Nov 2026**, then delete it on the owner's word.
- [ ] Backup dumps are only in the session scratchpad (`backup-prod-20261028-1245`). Keep a copy elsewhere if wanted.
- [ ] Optional, for speed: production compute min 0.5 CU with scale-to-zero off (no cold start after quiet spells).
- [ ] Next speed step: take the follow-up work out of the approval request (see the diagnosis report).

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
- The parked schemas are copied too. A `switch-back` of the split is already impossible on production (migrations changed seller tables since the switch; see B), so `drop-parked` before the move would only make the copy smaller. That is the owner's call.

## Checklist for the owner

- [x] Approve creating the two Singapore Neon projects (done 28 Oct 2026).
- [ ] Approve the staging move (any time).
- [ ] Approve the production window (date and time, IST).
- [ ] Confirm the old projects may be deleted after 7 days (test) / 14 days (production).
