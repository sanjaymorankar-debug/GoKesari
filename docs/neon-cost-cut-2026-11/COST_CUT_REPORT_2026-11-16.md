# GoKesari: Neon cost cut, 16-Nov-2026

**Report written:** 16-Nov-2026, 09.00 IST; completed 13.30 IST.
**Scope:** GoKesari only: gokesari.com (production) and test.gokesari.com (staging). The bkesari projects that sit in the same Neon account were not opened, changed or tested; their checks belong in that project's own chat.
**All times are IST (UTC + 5:30).**

## Summary

- **Bill:** about **$57.50 a month (≈ ₹5,000)** before → about **$22-26 a month (≈ ₹1,900-2,250)** after.
  - Production is confirmed at 900-912 CU-s an hour (half of before).
  - Staging's quiet-hour figure comes tonight. Every hour today had testing on it.
- **Production:** compute floor halved (0.5 → 0.25 CU), ceiling capped at 2 CU, still always on.
- **Staging:** ceiling capped at 1 CU; it now sleeps between the 6-hourly cron runs.
- **Clean-up:** split leftovers dropped on both sites, 6 old databases and 9 old branches deleted, and the 2 idle us-east-2 projects deleted. Every one was backed up first with `pg_dump -Fc` and checked with `pg_restore --list` (55 files, 180 MB).
- **Nothing broke:**
  - Production QA: 75 passed, 1 failed (already failing on 04-Nov), 54 skipped.
  - Smoke checks on both sites passed after each change.
  - Full staging regression (10.37-12.57): 565 passed. None of its 14 failures was caused by today's changes, and there were no database errors. Details in `GOKESARI_TEST_REPORT_2026-11-16.md`.

## Before and after

| | Before (15-Nov) | After (16-Nov) |
|---|---|---|
| **Production compute** | 0.5-8 CU, never sleeps: 1,800 CU-s an hour | 0.25-2 CU, never sleeps: **900 CU-s an hour** (07.30-08.30 IST) |
| **Staging compute** | 0.25-8 CU, awake around the clock (every-minute cron): 900-922 CU-s an hour | 0.25-1 CU, sleeps after 5 min idle; every-minute line every 6 h: 541-565 CU-s an hour while being tested; a quiet hour expected under 100 |
| **Production databases** | `neondb` + 2 split leftovers (`PROD_CUSTOMER_DATABASE_URL`, `PROD_SELLER_DATABASE_URL`) | `neondb` only |
| **Staging databases** | `neondb` + `neondb_test`, `Test_Shop_owners`, `gokesari_customer`, `gokesari_seller` | `neondb` only |
| **`fdw_old_*` schemas and `gk_seller_retired` server** | in both `neondb`s (202 foreign tables on staging) | dropped on both |
| **Production branches** | main + 6 | main + 3 (older pre-release branches, not on the list) |
| **Staging branches** | main + 8 | main + 2 newest auto-backups |
| **us-east-2 projects** (`GoKesari-prod`, `GoKesari-test`) | idle since 29-Oct / 02-Nov | deleted 08.55 (recoverable until 23-Nov) |
| **Monthly cost** | ≈ $57.50 (≈ ₹5,000) | ≈ $22-26 (≈ ₹1,900-2,250) |

## Changes, in order

| Time (IST) | Site | Change | Check after |
|---|---|---|---|
| 15-Nov 11.25 | both | Items 1-2: cron sweeps leave rows with nothing to do alone (PR #387 → release #388) | Post-deploy check 5/5 |
| 15-Nov 23.35 | production | Cron installed (every-minute, hourly, daily lines) | Runs logged without errors |
| 16-Nov 06.25 | production | Minimum compute 0.5 → 0.25 CU (`ep-calm-salad-ao1homrr`); 0.25 is Neon's smallest size, so 0.10 is not possible | Back in 9 s; post-deploy check 5/5 (06.26-06.30) |
| 16-Nov 06.30 | staging | Every-minute cron line → `0 */6 * * *` (05.30, 11.30, 17.30, 23.30 IST) | Hourly and daily lines unchanged |
| 16-Nov 06.39 | production | Maximum compute 8 → 2 CU; scale to zero stays **off** (`suspend_timeout_seconds = -1`) | Post-deploy check 5/5 (06.40-06.44) |
| 16-Nov 06.42-07.05 | all | Backups of every database on every branch to be deleted (below) | 50 files, all `pg_restore --list` OK |
| 16-Nov 06.51 | production | Dropped `fdw_old_public`, `fdw_old_pmd` (CASCADE) and server `gk_seller_retired` in `neondb` | No live object depended on them |
| 16-Nov 06.52 | production | Deleted databases `PROD_CUSTOMER_DATABASE_URL`, `PROD_SELLER_DATABASE_URL` | Code reads only `DATABASE_URL` |
| 16-Nov 06.52 | production | Deleted branches `pre-release-2026-11-01-staging-38028378`, `fdw-removal-dryrun-2026-11-04`, `pre-fdw-removal-2026-11-04` | Post-deploy check 5/5 (06.53-06.57) |
| 16-Nov 07.06 | staging | Deleted branches `fdw-removal-dryrun-2026-11-02`, `pre-fdw-removal-2026-11-02`, `backup-before-shop-wipe-2026-10-30`, `auto-backup-…-run115/116/117` | Kept run118 and run119 |
| 16-Nov 07.10-07.21 | production | Production-safe QA run (read-only) | 75 passed, 1 old failure, 54 skipped |
| 16-Nov 08.46-08.48 | staging | Backups of staging main's 5 databases | 5 files, all OK |
| 16-Nov 08.50 | staging | Dropped `fdw_old_public`, `fdw_old_pmd` and `gk_seller_retired` in `neondb` | Nothing outside them referred to them; 313 app + 136 product-master tables intact |
| 16-Nov 08.50 | staging | Deleted databases `neondb_test`, `Test_Shop_owners`, `gokesari_customer`, `gokesari_seller` | No sessions; no workflow uses them |
| 16-Nov 08.51 | staging | Maximum compute 8 → 1 CU, scale to zero 300 s (explicit) | Post-deploy check 5/5 on both sites (08.51-08.55) |
| 16-Nov 08.55 | us-east-2 | Deleted projects `GoKesari-prod` (`sparkling-scene-39325894`) and `GoKesari-test` (`weathered-cloud-85449869`) | Nothing pointed at them: both sites, `test-db.yml` and `prod-db.yml` all use the Singapore endpoints; both sites 200 at 08.56 |

**Code (PR #393: verified on staging 10.32; release to gokesari.com in PR #396):**
- Item 3: feature flags cached for 15 s, and the cache is cleared when a flag changes.
- Item 7:
  - The pool's default idle time goes from 20 s to 60 s.
  - `fetch_types` stays on, because the app reads PostgreSQL arrays, and turning it off would hand those back as text.
  - Both Hostinger sites set `DATABASE_IDLE_TIMEOUT_SECONDS` themselves, so the new default only applies if that variable is removed.
- `docs/crontab.txt` now lists production and staging schedules separately.

## Backups

**Folder:** `/Users/agtci/Documents/Doc_GoKesari/Devlopment_Trackers/neon_backups/` (55 files, 180 MB). Name pattern: `<project>_<branch>_<database>_<IST date-time>.dump`.

| Source | Files | Biggest |
|---|---|---|
| GoKesari-prod-sg: main + 3 deleted branches, each `neondb` + 2 split databases | 12 | `main_neondb` 4.1 MB (3,930 entries) |
| GoKesari-test-sg: main + 6 deleted branches, each 5 databases | 35 | `main_neondb` 18 MB (3,942 entries) |
| GoKesari-prod (us-east-2): `production` branch, 3 databases | 3 | `neondb` 2.0 MB |
| GoKesari-test (us-east-2): `Go-Kesari-Production` branch, 5 databases | 5 | `neondb` 5.6 MB |

To restore one: `pg_restore --no-owner -d "<target connection string>" <file>.dump`.

## Deleted, and how long it can still be undone

| What | Deleted (IST) | Undo window |
|---|---|---|
| 3 production branches, 6 staging branches | 16-Nov 06.52 / 07.06 | Neon keeps deleted branches 3 days on this plan: until **19-Nov 06.52 / 07.06**. After that, from the dump. |
| 2 production databases, 4 staging databases | 06.52 / 08.50 | No separate undo; Neon's 6-hour restore history on `main` covers them until about 12.52 / 14.50 today. After that, from the dump. |
| `fdw_old_*` schemas, `gk_seller_retired` server | 06.51 / 08.50 | Same 6-hour restore history, then the dump. |
| us-east-2 projects | 16-Nov 08.55 | Neon keeps a deleted project 7 days: `recover_project` until **23-Nov 08.55**. After that, from the dump. |

## Not touched, and why

- **Production's 3 older pre-release branches** (`pre-release-2026-10-28-staging-to-main`, `pre-release-2026-10-31-staging-to-main`, `pre-release-2026-10-31-302-gig-worker`): not on the delete list. They are archived and under the 9 free branches, so they cost cents.
- **Staging's auto-backups run118 and run119:** kept as the latest 2. `test-db.yml` keeps the newest 5, so the nightly job will grow this back to 5. That is still under the 9 free branches, so it costs nothing. If the limit should be 2 permanently, the workflow's retention needs changing.
- **The `postgres_fdw` extension** stays installed on both `neondb`s: nothing uses it, and production already had it left in place.
- **bkesari projects** (6 in the same Neon account): on the do-not-touch list. No deletes, no setting changes, not opened.

## Savings check (task 4)

Neon's hourly compute figures (CU-seconds; 3,600 CU-s = 1 CU-hour = $0.106):

| Hour (IST) | Production | Staging | What was happening |
|---|---|---|---|
| Before (15-Nov, typical hour) | 1,800 | 900-922 | Production at 0.5 CU; staging kept awake by the every-minute cron |
| 06.30-07.30 | 1,286 | 1,670 | Settings being changed; backups of every branch (staging woke for each) |
| 07.30-08.30 | **900** | 565 | Production steady; staging queue testing #392 |
| 08.30-09.30 | **906** | 557 | Staging clean-up, restart, smoke tests; #393 CI |
| 09.30-10.30 | **912** | 541 | Staging queue deploying and testing #393 |

- **Production: target met.** It holds at 900-912 CU-s an hour, which is 0.25 CU around the clock and half the 1,800 before. The last production change was at 06.39, so these hours are well over 3 hours after it.
- **Staging: not yet measured quietly.** Every hour today had testing on test.gokesari.com: the staging queue, my clean-up, and the full regression. Even so, each busy hour used 40 % less than an idle hour before (541-565 against 900-922). Asleep, staging costs nothing. The hourly cron line still wakes it once an hour for about 5 minutes (about 75-100 CU-s), and the 6-hourly line adds a few more minutes four times a day. So a quiet hour should come in under 100 CU-s, well under the 300 target. *The first quiet hours will be tonight; their figure is to be added.*

## Projected monthly cost

At $0.106 per CU-hour, a 30-day month, and ₹87 to the dollar:

| | Before | After |
|---|---|---|
| Production compute | 1,800 CU-s/h → about $39 | 900-915 CU-s/h → **about $19.5** |
| Staging compute | about 910 CU-s/h → about $19 | about 90 CU-s/h when quiet, about 550 when testing. With 3-4 testing hours on a working day, **about $2-6** |
| Storage (both `neondb`s, branches) | about $0.15 | about $0.15 (6 databases and 9 branches fewer) |
| us-east-2 projects | idle, about $0 | deleted |
| **Total** | **about $57.50 a month (≈ ₹5,000)** | **about $22-26 a month (≈ ₹1,900-2,250)** |

That saves about **$32-35 a month (≈ ₹2,800-3,100)**, a cut of 55-60 %. Production is now a fixed floor: about $19.5 a month, as long as it stays at 0.25 CU and never sleeps. Staging's share depends on how much it is tested.

## Owner actions (not done here)

1. **Hostinger environment leftovers.** These variables are unused by the code; remove them in hPanel → the site → Node.js → Environment variables:
   - gokesari.com: `SELLER_DATABASE_URL`, `DB_SPLIT_MODE`, `PROD_CUSTOMER_DATABASE_URL`, `PROD_SELLER_DATABASE_URL`.
   - test.gokesari.com: `SELLER_DATABASE_URL`, `DB_SPLIT_MODE`.
   - The API shows these values masked, and replacing variables there needs the full set, so this is safer in hPanel.
2. **GitHub repository settings left over from the split and from us-east-2.** No workflow reads them:
   - Variable `NEON_PROJECT_ID = sparkling-scene-39325894` (the deleted us-east-2 project). `test-db.yml` uses `TEST_NEON_PROJECT_ID`, which defaults to Singapore.
   - Secrets `PROD_CUSTOMER_DATABASE_URL`, `PROD_SELLER_DATABASE_URL`, `TEST_CUSTOMER_DATABASE_URL`, `TEST_SELLER_DATABASE_URL` and `NEON_API_KEY`.
   - `PROD_DATABASE_URL` and `TEST_DATABASE_URL` are in use and correct. The last runs reached `ep-calm-salad` (production) and `ep-hidden-star` (staging), both in Singapore.
3. **`DATABASE_IDLE_TIMEOUT_SECONDS`** on both Hostinger sites: remove it, or set it to 60, so item 7's longer idle time applies.

## Next: stop GoKesari's Neon charges completely (owner's decision, 16-Nov-2026)

The owner chose to move both GoKesari databases off Neon onto their own PostgreSQL 18 server (a VPS). After that, the two GoKesari Neon projects can be deleted, and GoKesari's Neon charges drop to $0; the VPS becomes the cost.

- A separate session is writing the migration plan: `GOKESARI_NEON_TO_VPS_PLAN_<date>.md` in this folder. It covers VPS size and cost, backups, the cut-over and rollback, and the decisions for the owner.
- Nothing is bought, switched or deleted until the owner approves each step.
- The Neon account and its plan also hold the bkesari projects. Cancelling or downgrading the account is decided in that project's own chat, not here.
- Neon has no monthly minimum. Until the move, GoKesari pays only for the compute it runs: about $22-26 a month.

## Mobile apps

No app change or rebuild is needed. The Android and iOS apps (`mobile/`) are a WebView shell of the website. They call only `/api/app/version` and the push-token endpoint, and neither the API nor the data contract changed. Both sites answered normally after every change.

## Staging's 6-hour cron: what to expect when testing

Everything in the every-minute group now happens up to 6 hours late on test.gokesari.com:
- order timeouts (shop acceptance);
- notification retries and scheduled notices;
- rider re-dispatch and return-pickup retries;
- payment reconcile when a sandbox webhook is missed;
- document e-mails, bill captures, broadcasts and product-master ingest.

Specific gaps:
- Shop acceptance reminders can be skipped.
- A shop-open alert can be missed.
- A bank check whose webhook never arrives waits up to 6 hours, not 30 minutes.

A test that needs one of these jobs sooner calls the cron endpoint itself with `CRON_SECRET`. Production keeps the every-minute line.

## If GoKesari moves to its own PostgreSQL server later

Install **PostgreSQL 18** (both Neon projects run 18) with the `pg_trgm` and `btree_gin` extensions. `postgres_fdw` is no longer needed. Restore from a fresh `pg_dump -Fc` of each `neondb`. Then delete the two Singapore Neon projects so their charges stop.
