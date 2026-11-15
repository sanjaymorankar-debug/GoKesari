# Onboarding Phase 2, Wave 1 — test results

Local runs on 06-Nov-2026 (IST), branch `feat/onboarding-phase-2-wave1`, Postgres 18 on the owner's Mac.
Staging (test.gokesari.com) and production results are added below as they happen.

## 1. Automated

| Run | Time (IST) | Result |
|---|---|---|
| New tests `tests/integration/onboarding-phase-2-wave1.test.ts` | 16.20 | **8 / 8 pass** |
| Phase 1 tests `onboarding-phase-b.test.ts` (regression) | 16.20 | **8 / 8 pass** |
| Whole suite | 16.24–17.05 | **3,346 / 3,351 pass**. 5 failures, none from this change: `product-import-parser` and `product-import` "empty row" (the same failure on unchanged `staging`, checked 17.05; recorded before in TEST_RESULTS_flow_2026-10-30.md); `migrate-on-build` ×3 timed out on the local test database — the same file passes **7 / 7** with this branch on a fresh base database (17.00), and both new migrations apply on an empty database in 2 s, also with two runs at once |
| Typecheck (`tsc --noEmit`), lint (changed files) | 16.15 | clean |

### Cases covered by the new tests

| # | Case | Result |
|---|---|---|
| W1-01 | Shelf ranks by orders in the last 90 days; an order 200 days old does not count (Q1) | Pass |
| W1-02 | Publish: good rows listed in one go with price, stock, sale flags | Pass |
| W1-03 | Opening stock written to the stock ledger (source `starter_shelf`); stock 0 writes none | Pass |
| W1-04 | Negative: price above MRP, half a pack, unknown product refused on their own | Pass |
| W1-05 | A product from a category the shop did not carry (scanned) links that category | Pass |
| W1-06 | Negative: publishing an already listed product → "Already in your shop.", not first products | Pass |
| W1-07 | Barcode found by GTIN-14 typed, EAN-13 stored; "listed" after listing; unknown → no match; too short → refused | Pass |
| W1-08 | Unknown barcode → owner's product PENDING_APPROVAL with the code; found again as "not approved" (Q9) | Pass |
| W1-09 | Pickup only → delivery off, checklist line done; own staff → delivery on, radius saved | Pass |
| W1-10 | Reminder set 24 h ahead at a step; nothing sent early | Pass |
| W1-11 | Sent at 24 h, moved to 72 h; not sent twice in the same minute; sent at 72 h; then stops | Pass |
| W1-12 | Coming back to the wizard restarts the reminder at stage 1 | Pass |
| W1-13 | Negative: a registration no longer waiting on the owner gets no reminder | Pass |
| W1-14 | Admin list shows a registration idle > 24 h with owner e-mail, step and reminders sent | Pass |

## 2. Staging (test.gokesari.com)

| Run | Time (IST) | Result |
|---|---|---|
| Staging queue, PR 356: CI | 17.14 | Blocked: typecheck error in the new test file (null-check) — fixed, re-queued |
| Staging queue, PR 356: CI, migrations 0146–0147, deploy, health | 18.02–19.11 | Pass (merged 18.02) |
| Staging queue, PR 356: guest QA tier | 19.11 | **1 failed**: `/legal/social-welfare-policy` open to a guest — not from Wave 1 (page published as public in PR 354; QA list out of date). Fixed by PR 358 (`staging-fix`) |
| Staging queue, PR 358: CI, deploy, health, guest QA | 20.06–21.20 | **Pass — staging-verified** |
| Browser, signed-in shop owner, 375 × 812: `/shop/setup/delivery` | 19.20 | Pass: three choices, "Own staff" shows the radius slider (5 km) and "Add delivery staff"; no console errors. Not saved (test shop unchanged) |
| Guest: `/shop/setup/delivery` → page, barcode API → 401 | 21.55 | Pass |

## 3. Production (gokesari.com)

| Run | Time (IST) | Result |
|---|---|---|
| Production database workflow (`migrate`, source staging; backup first) | 21.46 | Pass: 2 new migrations (0146, 0147); 148 recorded |
| Release PR 359 (staging → main) | 21.47 | Merged (only PRs 356 and 358; no other release in flight) |
| Post-deploy check workflow | 21.54 | Pass — but on the previous build: the new build went live at 21.56 |
| Post-deploy check script, re-run on the new build | 21.56–22.01 | **Pass: 5 / 5 healthy rounds** |
| Guest checks: `/`, `/shops`, `/legal/social-welfare-policy` 200; `/admin/onboarding-funnel` → sign-in; `/shop/register` 200; barcode API 401 | 22.01 | Pass |

Signed-in production checks were not run (no owner go-ahead for a signed-in session on gokesari.com).

## 4. Not tested yet

- Camera scanning on a real Android and iPhone (inside the apps and in the browser).
- A reminder e-mail arriving in a real inbox (staging).
