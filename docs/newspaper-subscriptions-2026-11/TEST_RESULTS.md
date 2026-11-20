# Newspaper subscriptions — test results

Feature: [PROMPT.md](PROMPT.md) · design: [DESIGN.md](DESIGN.md) · PR
[#423](https://github.com/sanjaymorankar-debug/GoKesari/pull/423) (into `staging`).

## 1. Local — 20-Nov-2026, 09.16–09.30 IST

Local PostgreSQL databases made for this run only (`gk_news_test`, `gk_news_test2`, `gk_news_ui`), all migrations to 0152 applied.

| Suite | Result |
|---|---|
| `tests/unit/periodicals.test.ts` — day-of-month schedule, defaults per title, labels, 30-day count | 14 / 14 pass |
| `tests/integration/newspaper-subscriptions.test.ts` — titles, vendor search, grouped submission, refusals, vendor notice and list, API routes, generation | 13 / 13 pass |
| Existing subscription suites (`subscription-engine`, `subscription-states`, `schedule`) and `tile-board` (menu counts) | pass (114 tests across the 6 files) |
| Typecheck (`tsc --noEmit`), lint on changed files, QA typecheck (`tsconfig.qa.json`) | clean |
| QA guest checks TC-SUB-020, 021, 022 against the local server (desktop + phone) | 4 pass, 2 desktop-only skipped on phone |
| Full unit + integration suite | see §1a |

### Browser walk-through (local server, desktop and 375 px phone)

| Step | Seen |
|---|---|
| Customer opens Newspapers & magazines | 51 titles, filters for type / language / search; no sideways scroll on a phone |
| Ticks The Times of India, Lokmat, India Today, Tinkle; Find vendors | Sai News Agency 0.4 km "4 of 4 titles" with prices; Corner Book Stall 1.4 km "1 of 4", "Not sold here: Lokmat, India Today, Tinkle" |
| Step 3 | Defaults: dailies every day, India Today Sun, Tinkle 1st of the month; Lokmat changed to Sun; 30-day estimate ₹520 (6×30 + 5×4 + 60×4 + 80×1) correct; wallet warning shown (₹500 < ₹520) |
| Subscribe to 4 titles | My Subscriptions with "Your newspaper subscriptions are set up", 4 cards "1 copy / delivery", Tinkle badged "1st of the month", tomorrow's paper on the Tomorrow card |
| Vendor (Sai News Agency) | Notice "New subscriber — 4 items: Asha Patil subscribed to India Today (1 copy, Sun); Lokmat (1 copy, Sun); The Times of India (1 copy, every day); Tinkle (1 copy, 1st of the month), starting 21 Nov 2026. Deliver to: Shivajinagar, Pune, 411005."; Orders → Subscribers shows the 4 subscriptions with address, New badge and per-item totals |

Note: a hydration warning seen once in the local browser came from the
service worker serving an older script after a code edit; after clearing it,
server and browser render the same.

## 1a. Full local suite — 20-Nov-2026, 09.17–09.58 IST

`npx vitest run` (every unit and integration file, one worker): **286 files, 3,565 tests — 3,561 pass, 4 fail**. None of the 4 is caused by this change:

| Failing test | Why | Re-run |
|---|---|---|
| `migrate-on-build.test.ts` (3 tests) | `CONNECT_TIMEOUT 127.0.0.1:5432` — the local PostgreSQL was serving a second test run and the preview server at the same time | Re-run alone on this branch: **7 / 7 pass**; also 7 / 7 on origin/staging without the change |
| `checkout-cart-race.test.ts` — "the same product: the added units are ordered with the line, or stay in the cart" | A timing test that needs both orders of a race to happen; only one did in this run | Re-run alone: **pass** |

CI on the pull request runs the whole suite again on a clean PostgreSQL 16.

## 2. test.gokesari.com (staging queue)

(filled in after the queue merges and verifies #423)
