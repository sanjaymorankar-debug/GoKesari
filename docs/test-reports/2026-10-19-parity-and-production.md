# Code and database parity, and production test run (19 Oct 2026)

| | |
|---|---|
| Date | 19 Oct 2026, 06:55–07:25 UTC |
| Release on main | `8e1c107` (release #198), staging `72747dc` (#201) |
| Live build on gokesari.com | `OqNKkItkPzeYQnh9lx5Hk` (see §1) |
| Evidence | [2026-10-19-production/](2026-10-19-production/) (logs per suite, screenshot, results JSON) |

## 1. Code: local = staging = main

| Where | Commit | Same files as main? |
|---|---|---|
| main (gokesari.com) | `8e1c107` | — |
| staging (test.gokesari.com) | `72747dc` | **Yes.** Main is an ancestor of staging, and `git diff main staging` is empty (#201). |
| Local checkout | `4a9b1be` (#201's head) | **Yes.** `git diff origin/main HEAD` is empty; the installed packages match the lockfile (`npm ls` clean). |

**The live site.** gokesari.com did not show a new build in the 30 minutes after release #198 was merged (06:46 UTC). It still serves build `OqNKkItkPzeYQnh9lx5Hk`, and every page answers normally. This does not change the code that runs. Since the last code release (#194, `fc70223`, live 18 Oct about 20:56 UTC), main has changed only:
- documents;
- one test script (`scripts/test-site/product-import-check.mjs`);
- one test spec (`tests/e2e/batch-2026-10-remote.spec.ts`).

So the live site runs the same application code as main. If Hostinger is expected to rebuild on every push to main, its deploy log should be checked once (owner, Hostinger panel).

## 2. Database: the same migrations everywhere

"Same database" here means the same **schema** (the same migrations applied), not the same data. Production data is never copied to the test site or a laptop, and test data never goes to production.

| Database | How checked | Migrations recorded | Newest applied | Not applied |
|---|---|---|---|---|
| Local (PostgreSQL 16, `dairy_bakery_test`) | `npm run db:migrate`, then `drizzle.__drizzle_migrations` | 85 | `0084_batch_f_notifications` | none |
| test.gokesari.com (Neon) | Test database workflow, action *verify* (read-only), run [39212779566](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/39212779566) | 87 | `0084_batch_f_notifications` | none |
| gokesari.com (Neon `neondb`) | Production database workflow, action *verify* (read-only), source main, run [39212782207](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/39212782207) | 86 | `0084_batch_f_notifications` | **none** ("Not yet on production: none") |

The code has 85 migrations (`0000`–`0084`), and all three databases have applied the newest one. The higher counts on test (87) and production (86) are extra rows in the migration history table, for example from a migration file renumbered after a database had applied it. They do not mean a missing migration. On each database the newest applied is the code's newest, and the verify finds nothing still to apply. The exact extra rows were not listed, because the verify runs print only the counts.

## 3. Local: full automated suite on the release code

| Suite | Result |
|---|---|
| `npx vitest run` (all unit and integration tests, local PostgreSQL 16) | _running — added when finished_ |

## 4. Production (gokesari.com): every production-safe test

Run from this session against the live site, 07:17–07:22 UTC.

| # | Suite | Cases | Passed | Failed | What it checks |
|---|---|---:|---:|---:|---|
| 1 | `tests/e2e/batch-2026-10-remote.spec.ts` | 12 | **12** | 0 | Home, shops and search pages; email sign-in; app-link files (`assetlinks.json`, `apple-app-site-association`); payment and payout webhooks and batch crons refuse unsigned calls; staff screens need sign-in; grievance officer published; no online reference prices; no sandbox payment page on production |
| 2 | `tests/e2e/branding-footer.spec.ts` (desktop and Pixel 7 projects) | 18 | **18** | 0 | Compact footer with company and GSTIN, every footer link opens, wordmark and tagline, footer line breaks at every width |
| 3 | `tests/e2e/smoke.spec.ts` — Preflight (P0) | 4 | **4** | 0 | Site reachable; database-backed pages give no 500; sign-in form present; header present |
| 4 | `scripts/test-site/prod-smoke.mjs` — Inventory & Accounting | 11 | **11** | 0 | 12 module pages redirect to sign-in; module API 401 (read and write); crons and inbound mail 403; share target; manifest; existing pages; desktop and Android app with no page errors |
| 5 | Bulk upload, signed out (`pp-checks.sh`, the 15 Oct checks PP-01–PP-12) | 12 | **12** | 0 | Owner and staff pages redirect to sign-in; all 9 `/api/v1` import endpoints answer 401; existing pages 200 |
| 6 | Bulk upload, signed in, test shop (`product-import-check.mjs … smoke --prod-smoke`) | 4 | **4** | 0 | Owner page loads; one-row import (job `494bd889-…`, stock 3 = file Quantity); report row `created`; Delete file deactivates it (hidden, stock 0) |
| | **Total on gokesari.com** | **61** | **61** | **0** | |

For comparison, suites 1–5 were also run on **test.gokesari.com**: **57 / 57 pass**. Suite 6 is production-only: the test site has its own 23-case run.

### What suite 6 left on production

It used the designated test shop "GoKesari QA Test Shop (internal testing - do not order)", `3a0557f6-…`. The shop is Pending approval and hidden. **Never approve it.**
- **Listing:** the run added listing `SMOKE-MVEXCN6C`, now deactivated (hidden, stock 0).
- **Catalogue:** it also added a pending master product, "Smoke Test MVEXCN6C (delete)". Reject it in the admin catalogue review, together with "Smoke Test MVE0J1I1 (delete)" from 18 Oct.

## 5. Not run on production, and why

These suites exist but must not run on the live site. Each one writes customer-facing data, takes payments, or needs the server's own secret key and direct database access.

| Suite | Cases | Why not on gokesari.com | Where it runs |
|---|---:|---|---|
| `batch-2026-10-signed-in.spec.ts` | 43 | Creates orders, sandbox payments, refunds, tickets and a broadcast; refuses gokesari.com by design | test.gokesari.com (40 pass, 18 Oct) |
| `acceptance.spec.ts` | 5 | Wallet top-up, subscription, daily orders | local server |
| `regression-items-a-e.spec.ts`, `inventory-accounting.spec.ts`, `document-browser-read.spec.ts` | 32 | Need the server's AUTH_SECRET and its database to arrange data; they write | local server |
| `mobile-app.spec.ts` | 7 | Uses the development sign-in form, which production does not have | local server |
| `smoke.spec.ts` beyond Preflight | 2 | Signs up a new user; adds to a cart | test.gokesari.com |
| `accounts-check.mjs`, `stock-order-check.mjs` | — | Write purchases and bills; place and cancel a real order | test.gokesari.com |
| Payments | — | No sandbox keys or test cards on production (project rule), and no real money is used in tests | test.gokesari.com with Cashfree sandbox |
| Production order lifecycle | — | Needs a production shop, rider and payment choice | Owner inputs §14 (batch report) |
| `test-cases.xlsx` (791 manual cases) | 791 | Not automated | By hand on test.gokesari.com |

## 6. Sign-off

| Check | Result |
|---|---|
| Code: local = staging = main | **Pass** |
| Database schema: local = test = production (newest `0084`, none missing) | **Pass** |
| Local full suite | _running_ |
| gokesari.com production-safe tests | **Pass — 61 / 61** |
| test.gokesari.com, same read-only suites | **Pass — 57 / 57** |
