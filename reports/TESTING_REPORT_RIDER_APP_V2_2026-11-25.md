# Testing report — Rider App v2 + Rider Pay Plans (25-Nov-2026)

PR: https://github.com/sanjaymorankar-debug/GoKesari/pull/568 · Branch `feat/rider-app-v2-2026-11-25` · Migration 0206

## Run 1 — local (gk_rider_v2 test database, all migrations to 0206), 25-Nov-2026 14.55–15.15 IST

| Suite | Cases | Pass | Fail |
|---|---|---|---|
| Unit: pay formula (`rider-pay-plan.test.ts`) — worked examples ₹55 / ₹30, slab edges 2/4/7/10 km, first-mile cap, long-distance edge, extra drop, surge stacking, cap, rounding, quote lock, reroute tolerance, wait pay, plan checks, ledger balance | 42* | 42 | 0 |
| Unit: admin format helpers, rider safety, rider growth, earnings week, rider privacy key scan | 61 | 61 | 0 |
| Integration: pay plans + job board (RV2-001…014: flags off unchanged, migrated plan pays same, offer quote = locked quote, publish never changes a locked quote, publish needs simulation + note, rain surge on/off, job board off, privacy scan, **two riders accept at once → exactly one wins**, pass hides job, offline sees nothing) | 11 | 11 | 0 |
| Integration: rider safety (SOS raise / one-open / ack / close, insurance eligibility, nominee) | 4 | 4 | 0 |
| Integration: rider growth (referral qualify + reward once, tier, slot booking capacity race 5→2, reminders) | 8 | 8 | 0 |
| Regression: whole unit suite + delivery / rider / broadcast / payouts / cron integration (after merging staging) | 2,036 | 2,036 | 0 |
| Full integration suite (before merging staging) | 3,036 | 3,032 | 4 |

\* includes the earnings-calc suite run with it.

### Defects found and fixed
| # | Defect | Fix | Retest |
|---|---|---|---|
| RV2-D1 | Surge / quote-kit queries passed a JS Date into raw SQL (postgres-js bind error) | Use `gt()` column comparisons | Pass |
| RV2-D2 | `cron-safety-net` expected the old timeout-sweep keys | Added `riderSlotReminders` to the expected list | Pass |
| RV2-D3 | SOS "close" audited as "acknowledged" | New audit action `rider_sos.closed` | Pass |
| RV2-D4 | Migration number 0201 taken by #529 on staging | Renumbered to 0202, journal merged | Pass (fresh DB migrate) |

Open: `migrate-on-build.test.ts` (3 cases) timed out connecting to the local test server (CONNECT_TIMEOUT) — environment; decided by CI's own database in the staging queue.

## Run 2 — test.gokesari.com (staging)
Pending: PR #568 queued in the staging queue at 15.20 IST (CI, migration, deploy, post-deploy check, guest QA run by the queue). Then: switches ON on staging and rider / admin walk-through (go online → list → ₹ → accept → complete → earnings week; reject; SOS; insurance; slot booking; referral; admin plan → simulate → publish → new offer shows new pay; surge on/off).

## Run 3 — gokesari.com (production)
Not started. Production release at the 23.00 IST window after staging verification; switches stay OFF on production until the owner says.

## Not covered yet
- Screens not yet seen in a browser / Expo WebView / 360 px phone — checked on staging in Run 2.
- Android / iOS store builds (1.14.0): owner's store login needed.
- Performance target (job list ≤ 1 s for 200 open jobs): the list reads one query + a batched quote kit; to be measured on staging.
