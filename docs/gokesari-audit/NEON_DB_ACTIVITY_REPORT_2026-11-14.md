# GoKesari: Neon database activity report

14-Nov-2026, 23.50 IST. Read-only checks. Nothing was changed on Neon or in the code.

Sources: Neon consumption API (daily and hourly), endpoint settings, `pg_stat_activity`,
`pg_stat_statements` (staging since 11-Nov 19:16 UTC, production since 03-Nov 02:06 UTC), and the code.

## Projects checked (GoKesari only)

| Project | Site | Endpoint | Min / max CU | Scale to zero |
|---|---|---|---|---|
| GoKesari-prod-sg (`lively-frost-99365966`) | gokesari.com | ep-calm-salad-ao1homrr | **0.5** / 8 | **Disabled** (`suspend_timeout_seconds = -1`) |
| GoKesari-test-sg (`curly-night-16641982`) | test.gokesari.com | ep-hidden-star-b3k0l6ih | 0.25 / 8 | On (5 min), but never reached |
| GoKesari-prod / GoKesari-test (us-east-2) | none (old) | idle since 02-Nov / 29-Oct | – | storage only |

## What the numbers show

### Production: always on, almost no work
- **Compute:** exactly 1,800 CU-seconds every hour, around the clock. That is 0.5 CU × 3,600 s, the floor of the compute.
  - Load almost never goes above the floor.
  - The database has 0 orders.
  - The every-minute cron queries ran about 16 times in 11 days.
- **Cost:** this is a settings cost, not a load cost.
  - About 12 CU-hours a day, about 360 CU-hours a month.
  - About **$38 a month** at the Launch price of $0.106 per CU-hour.

### Staging: kept awake by a minute-by-minute loop
- **Compute:** about 900 CU-seconds every hour, around the clock (0.25 CU × 3,600 s).
  - It never gets the 5 idle minutes it needs to suspend, because the Hostinger cron calls `/api/cron/every-minute` every minute.
  - About **$19 a month**.
- **Network:** a flat 19 MB an hour of public network transfer (about 460 MB a day). Production moves about 0.2 MB an hour.

#### Queries since 11-Nov 19:16 UTC (4,246 cron ticks)

| Calls | Rows each | What |
|---|---|---|
| 335,434 × 3 | 1 | order, delivery slot and shop, loaded one order at a time |
| 326,942 × 4 | 0 or 1 | rider search, delivery order, broadcast, shop status |
| 4,246 | **79** | `orders JOIN shops WHERE status='READY' AND delivery_available` |
| 16,984 × 4 | 1 | return pickups, 4 per tick |
| 12,950 / 12,842 | 44 / 19 | `platform_settings` / `feature_flags` reads |

## Causes

1. **Dispatch sweep re-processes the same stuck orders every minute.**
   - Where: `runDispatchSweep` in `src/server/services/delivery-assignment.ts`, lines 1809-1823.
   - It picks every READY order at a delivery shop, up to 200, and calls `dispatchReadyOrder` for each one.
   - Staging has 79 READY test orders from 04 to 09 Nov. 77 of them have a rider search that is already **STOPPED**.
   - For each one, `dispatchReadyOrder` runs about 7 queries before `ensureSearch` reports STOPPED and it returns at line 1409.
   - That is about 550 queries a minute that do nothing. They return full order and shop rows, which is the 19 MB an hour.
   - The cost grows with every order left in READY. The same would happen on production.
2. **Return-pickup sweep has the same pattern.**
   - Where: `runReturnPickupSweep` in `src/server/services/return-pickups.ts`, lines 476-489.
   - When no rider qualifies, `offerPickup` returns without raising `attempts` or `updatedAt`.
   - The same pickups (4 on staging) are retried every minute, without end.
3. **Feature flags have no cache.**
   - `getFeatureFlags` in `src/server/services/feature-flags.ts` reads the table on every call.
   - `platform_settings` has a 15-second cache in `settings.ts`.
4. **Production compute is pinned on.**
   - Scale to zero is disabled and the minimum is 0.5 CU, so it bills 24/7 whether or not anyone uses the site.
5. **Smaller items:**
   - **New-connection lookup:** each new postgres.js connection runs a type-lookup query that returns about 1,000 rows.
     - On production this is the top statement: 2,373 calls and 2.36 M rows.
     - The pool's 20-second idle timeout makes connections churn.
   - **Old branches:** branches kept from earlier work add branch-hours.
     - Staging: 5 daily auto-backups, 2 from the FDW-removal dry run, 1 archived.
     - Production: `pre-release-2026-11-01`, plus 2 from the FDW-removal dry run.
   - **Leftovers from the database split:** both sites still have the `fdw_old_*` foreign-table schemas and the `gk_seller_retired` server. Staging also has unused databases (`neondb_test`, `Test_Shop_owners`, `gokesari_customer`, `gokesari_seller`).

## What is required

| # | Change | Where | Effect | Needs |
|---|---|---|---|---|
| 1 | Dispatch sweep: select only READY orders whose rider search is missing or SEARCHING, with `next_attempt_at` due, in the one query | code | Removes about 95% of staging queries and almost all of the 19 MB an hour | Code change + tests |
| 2 | Return-pickup sweep: raise `attempts` or `updatedAt` when no rider is found, so the retry interval and limit apply | code | Stops the endless retry of the same pickups | Code change + tests |
| 3 | Cache feature flags for 15 s, like `getRule` | code | Fewer small reads | Code change |
| 4 | Cancel or close the 79 stuck READY test orders on staging | staging data | Immediate relief before the code fix ships | Owner OK |
| 5 | Production endpoint: set the minimum to 0.25 CU (halves the floor, about $19 a month saved). Optionally turn scale to zero back on: 5-min suspend, about 0.5-1 s first-request delay after idle | Neon settings | $19-38 a month | Owner decision |
| 6 | Staging cron: run the every-minute group every 10-15 min (or only in working hours) so staging can suspend | Hostinger crontab | Staging compute drops to the hours actually used | Owner decision |
| 7 | postgres.js `fetch_types: false` (the app uses no custom enum or array types from the database; check first) and a longer idle timeout | `src/server/db/index.ts` | Removes the 1,000-row lookup on each new connection | Code change |
| 8 | Delete old branches (keep the latest 1-2 auto-backups) and the idle us-east-2 projects | Neon | Lower branch and storage charges | Owner OK (permanent delete) |

## Also noticed
- **Production cron:** the every-minute queries ran only about 16 times in 11 days. That suggests the cron in `docs/crontab.txt` is not installed on gokesari.com, or is failing. Payment reconcile, notification retries and timeouts would then not run on production. Worth checking in hPanel.
- **Split leftovers:** both sites are now on one database (staging's CLAUDE.md says so), but the retired `fdw_old_*` foreign-table schemas and the `gk_seller_retired` server are still in both databases.

## Status (15-Nov-2026)
- Items 1 and 2 are fixed on branch `fix/neon-idle-cron-sweeps`. Tests are in `tests/integration/cron-sweep-idle-rows.test.ts`. The release goes to test.gokesari.com through the staging queue, then to gokesari.com.
- Items 3-8 are still open.
