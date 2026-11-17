# Neon cost cut, 16-Nov-2026

> **Superseded on 17-Nov-2026 by the move to our own server.** Both sites'
> databases left Neon that morning (test.gokesari.com 05.52 IST, gokesari.com
> 06.06 IST) and now run on `gk-db-1`; see
> [docs/neon-to-vps-2026-11/](../neon-to-vps-2026-11/). The settings below are a
> historical record. Neon (retired, read-only until 1-Dec-2026) is kept only as
> a fallback, then deleted with the owner's OK. Staging's cron runs every
> minute again (owner decision D7).

**Scope:** gokesari.com and test.gokesari.com. **Owner's request:** 16-Nov-2026. **Times:** IST.

Neon bills compute time. Before the cut, production ran at 0.5 CU around the clock, and staging's every-minute cron kept staging awake. Together that came to about $57.50 a month. The owner's full report, with the measured savings, is `GOKESARI_NEON_COST_CUT_REPORT_2026-11-16.md` in `Doc_GoKesari/Devlopment_Trackers/`.

## Settings now

| | gokesari.com (`ep-calm-salad-ao1homrr`) | test.gokesari.com (`ep-hidden-star-b3k0l6ih`) |
|---|---|---|
| Compute | 0.25-2 CU | 0.25-1 CU |
| Scale to zero | off (`-1`) | after 300 s |
| Every-minute cron line | every minute | `0 */6 * * *` |
| Databases | `neondb` | `neondb` |
| Branches | main + 3 archived pre-release branches | main + newest auto-backups (`test-db.yml` keeps 5) |

0.25 CU is Neon's smallest compute; it cannot go lower.

## What changed

| Time (IST) | Change |
|---|---|
| 15-Nov 11.25 | Cron sweeps skip rows with nothing to do (#387, released in #388) |
| 16-Nov 06.25 | Production minimum 0.5 → 0.25 CU |
| 16-Nov 06.30 | Staging every-minute line → every 6 hours (hPanel) |
| 16-Nov 06.39 | Production maximum 8 → 2 CU |
| 16-Nov 06.51-06.52 | Production: dropped `fdw_old_public`, `fdw_old_pmd`, server `gk_seller_retired`; deleted databases `PROD_CUSTOMER_DATABASE_URL`, `PROD_SELLER_DATABASE_URL`; deleted branches `pre-release-2026-11-01-staging-38028378`, `fdw-removal-dryrun-2026-11-04`, `pre-fdw-removal-2026-11-04` |
| 16-Nov 07.06 | Staging: deleted branches `fdw-removal-dryrun-2026-11-02`, `pre-fdw-removal-2026-11-02`, `backup-before-shop-wipe-2026-10-30`, auto-backups run115-117 |
| 16-Nov 08.50-08.51 | Staging: dropped the same schemas and server; deleted databases `neondb_test`, `Test_Shop_owners`, `gokesari_customer`, `gokesari_seller`; maximum 8 → 1 CU, scale to zero 300 s |
| 16-Nov 08.55 | Deleted the idle us-east-2 projects `GoKesari-prod` (`sparkling-scene-39325894`) and `GoKesari-test` (`weathered-cloud-85449869`) |

**Code (#393):**
- Feature flags are cached for 15 s.
- The pool's default idle time is 60 s.
- `docs/crontab.txt` has separate production and staging schedules.
- `fetch_types` stays on, because the product-master code reads and sends PostgreSQL arrays.

## Safety checks before deleting

- **Backups:** every database on every branch and project deleted was dumped with `pg_dump -Fc` and checked with `pg_restore --list` first (55 files). The dumps are on the owner's Mac in `Doc_GoKesari/Devlopment_Trackers/neon_backups/`, not in this repository.
- **No dependants:** no view, function, column default or other object outside `fdw_old_*` referred to anything inside them.
- **No connections:** no session was open on the deleted databases.
- **Code:** the app reads only `DATABASE_URL` (including `appSql()`).
- **Workflows:** `test-db.yml` and `prod-db.yml` reach the Singapore endpoints (`ep-hidden-star`, `ep-calm-salad`). No workflow reads the split secrets or the repository variable `NEON_PROJECT_ID`.
- **Smoke checks:** both sites passed `scripts/release/post-deploy-check.sh` after each step.

## Undo

- **Deleted branches:** recoverable in Neon until 19-Nov 06.52 (production) / 07.06 (staging).
- **Deleted projects:** `recover_project` until 23-Nov 08.55.
- **Anything else, or after those dates:** `pg_restore --no-owner -d <connection string> <file>.dump`.

## Left for the owner

These settings are unused:
- Hostinger environment variables: `SELLER_DATABASE_URL` and `DB_SPLIT_MODE` on both sites, plus `PROD_CUSTOMER_DATABASE_URL` and `PROD_SELLER_DATABASE_URL` on gokesari.com.
- GitHub: variable `NEON_PROJECT_ID` (the deleted project), and secrets `PROD_/TEST_CUSTOMER_DATABASE_URL`, `PROD_/TEST_SELLER_DATABASE_URL` and `NEON_API_KEY`.

`DATABASE_IDLE_TIMEOUT_SECONDS` is set on both Hostinger sites. The new 60-s default applies only once it is removed or set to 60.
