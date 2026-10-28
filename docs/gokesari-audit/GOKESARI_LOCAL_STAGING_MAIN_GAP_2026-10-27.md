# GoKesari: gap between local, staging and main — 27 Oct 2026

As of 27 Oct 2026, about 22:15 IST, after `git fetch`. GoKesari only.

## 1. Where each one is

| Code base | Branch / commit | Site | Last change | Latest migration |
|---|---|---|---|---|
| main | `origin/main` 76b9d34 (#262) | gokesari.com | 25 Oct 18:27 | 0091 in code; 0092–0094 already on the production database (E-03 note) |
| staging | `origin/staging` 7425434 | test.gokesari.com | 27 Oct 21:50 | 0097 `admin_managed_shop_types` |
| local | `staging` 2b15062 (Mac checkout) | — | 27 Oct | 0097 (same as staging) |

- main is still the 24 Oct release: #261 was rolled back by #262 during outage E-03.
- main has nothing staging lacks. main's extra commits are the #261 copies of the #254 work plus their revert, and the #254 originals are on staging.
- A trial merge of local `staging` into `origin/main` has **no conflicts**, and the result is exactly local `staging`'s files.

## 2. Local → staging (3 commits, not pushed)

| Commit | What |
|---|---|
| 0586129 | Product cards: owner name in bold on the first line, shop name second, then product and price. Search matches the owner's name, and every typed word must match (product, category, shop, owner, area or PIN), in any order. |
| 28c3ffd | Owner and shop names wrap to two lines instead of being cut off on phones. |
| 2b15062 | Test: `tests/integration/storefront-search.test.ts` (4 cases, pass on both database layouts). |

4 files, +101 / −15. No migration. Not in git: the stray `GoKesari/` folder (an old copy of the project) and `.claude/launch.json`.

## 3. Staging → main (waiting for production)

200 files, +5,754 / −398. PRs #243, #250–#254, #256–#260, plus 4 commits pushed straight to staging on 27 Oct.

| Work | Commits / PR | Migration |
|---|---|---|
| GAP-011, 012, 014, 016, 017, 018 (seven open bugs, 21 Oct report) | 7a7ec4b (#250) | – |
| Dates in India time (client and server); voucher upload refuses a past end date (D-105) | 36570cc, 87e0c5a, 991fd2a (#251) | – |
| D-103 signed-in header search (the "search not placed properly" bug), D-57, D-91, D-25, D-96, D-23, D-69 | 06f7e0f … 9a55e8c (#254) | 0092–0094 (already on production DB) |
| D-95 loose stock in decimals | 1d718fd (#257) | 0095, 0096 |
| GAP-013 rider returns; GAP-019 faster checkout | 29ae9a5 (#259) | – |
| One production release at a time; post-deploy check workflow (E-02) | 2bffde1 (#260) | – |
| Cut Node process load: disputes escalate on touch, cron gate, caching, no prefetch | 907a756, 7049567, 7bd85e7 (27 Oct, direct) | – |
| Six new shop types and an admin shop-types screen | 7425434 (27 Oct, direct) | **0097** |
| QA notes, reports, defect log | #252, #253, #256, #258, 2c9bf5d, 9623bc4, b550c42, e1a5671, 3dd995c | – |

Migrations a production release will apply: **0095, 0096, 0097** (0092–0094 are already there).

## 4. Work on other branches, not yet on staging

| Branch | Commits | What | Note |
|---|---|---|---|
| `claude/shop-registration-fee-categories` | 3 (27 Oct) | Registration fee ₹999 + GST, coupons, professional shop types | **Migration clash:** it adds its own `0097_professional_shop_types`, plus 0098 and 0099. It doesn't have staging's 7425434 (`0097_admin_managed_shop_types`). It must be rebased onto staging and renumbered (0098–0100) before merging. |
| `claude/festive-ride-udspyl` | 2 (25 Oct) | Driving Simulator placeholder page | Based on old code; review first. |
| `claude/peaceful-pascal-jai8w2` | 1 (26 Oct) | Report 26 Oct: staging vs main, E-03 | Docs only. |
| `claude/serene-curie-pwjjh2` | 1 (26 Oct) | QA: D-101 voucher dates re-tested (PR #263, draft) | Docs only. |

Older branches (2–19 Oct) with commits not on staging: amazing-cannon, awesome-dijkstra (PMD on MySQL), busy-euler, serene-gates, tile-board-ui, trusting-allen. They are stale; review or close them.

## 5. Checks on local `staging` (2b15062)

- Type check: pass. Lint: 0 errors, 4 warnings.
- Production build: pass, from a clean checkout.
- Browser, local copy with seed data:
  - The signed-in header lays out correctly at 1200 / 1024 / 800 px and on a phone.
  - Product cards and search behave as described in §2.
- Full unit + integration suite on one database and on the split layout: see the session reply for results.

## 6. To release

1. Push local `staging` and let test.gokesari.com deploy. Check it there.
2. Before merging, check that nothing else is in flight: open PRs into `main`, the last Post-deploy check run, the last Hostinger build (DEPLOYMENT.md §3).
3. Open one staging → main PR and merge it in an agreed window (E-03).
4. Wait for the Post-deploy check, or run `scripts/release/post-deploy-check.sh https://gokesari.com`.
5. Keep `shop-registration-fee-categories` out of this release until it is renumbered and tested on staging.
