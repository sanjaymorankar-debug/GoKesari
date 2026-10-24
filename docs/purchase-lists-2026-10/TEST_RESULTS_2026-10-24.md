# Purchase lists — QA test results, 24 Oct 2026

Feature: [README.md](README.md) (PR #231). Plan: module "Purchase lists" in `test-cases.xlsx`, TC-LIST-001 … 028 (feature IDs PL-001 … PL-007).
Checks: `tests/qa/guest/purchase-lists.spec.ts` (production-safe) and `tests/qa/signed-in/purchase-lists.spec.ts` (signed tier).
Raw results: `docs/testing/qa-runs/2026-10-24-local-purchase-lists.json`, `docs/testing/qa-runs/2026-10-24-staging-purchase-lists.json` and `docs/testing/qa-runs/2026-10-24-production-purchase-lists-release.json`.

## Summary

| Site | Build | Purchase-lists cases | Result |
|---|---|---|---|
| Local server (database gk_qa) | 49ba367 | 28 | 27 pass (6 of them partly covered), 1 manual (TC-LIST-028), 0 fail |
| test.gokesari.com | 487f11b (PR #231 merged into staging as 2853b3d; migrations up to 0090) | 28 | 27 pass (6 partly covered), 1 manual, 0 fail in the latest results; 2 first-attempt failures explained below |
| gokesari.com | main 8e9c537 (PR #237, live 16:04:33 UTC) | guest checks only (TC-LIST-001, 002, 006 guest half) | 3 of 3 pass (5 rows, desktop and phone); the other 25 sign in or write, so they are not run on production by rule |

"Partly covered" (Pass (partial) in the register): TC-LIST-006, 009, 013, 014, 017, 025 — what is not covered is named in each check (seller-side states such as "No longer sold" and an unapproved shop, which need seller data changed; the 99 cap on ADD is TC-LIST-020).
**No defect was found in purchase lists.** Two defects outside the feature were found on staging (D-100, D-101 below).

This run is also the re-test of **D-99** (sign-in refused on test.gokesari.com after #232): both test customers signed in and stayed signed in at 15:05 and 16:00 UTC — passed. Its root cause was the missing `revoked_sessions` table: #232's `0088_revoked_sessions` and the purchase-lists migration shared a journal timestamp and the test database skipped 0088; `0089_repair_revoked_sessions` (#231) creates it.

## Staging run (test.gokesari.com, 24 Oct 2026, 15:05–16:00 UTC)

- **Sign-in:** staging customer and customer2, one emailed-code round; `/api/auth/session` returned each user and `/orders` loaded (200, signed-in page) at 15:05 and again at 16:00 UTC — sessions stayed valid through the whole run.
- **Signed purchase-lists spec:** 32 pass, 2 fail, 1 manual in the first pass (26 min). The two failures:
  - TC-LIST-021 (15:22 UTC): setting up the cart, `POST /api/cart` (Burger Bun ×2) answered **500** `INTERNAL`.
  - TC-LIST-022 (15:24 UTC): the spec put two lines in the cart (both 200), but `/cart` showed "Your cart is empty" 5 s later, so "Save as a list" was not there.
  - Cause: another session was using the same staging customer at the same time — it placed order DB-20261024-ITRVQT at 15:22:54 UTC (this spec never checks out) and emptied the cart. Its simultaneous "add to cart" of the same product is what answered 500: reproduced and logged as **D-100** (a cart defect, not purchase lists).
  - Re-run alone at 15:36–15:38 UTC: **TC-LIST-021 pass, TC-LIST-022 pass** (TC-LIST-021 had also passed in its phone run at 15:33). The collected results keep the latest row per check.
- **Regression, guest tier** (`tests/qa/guest`, includes the purchase-lists guest checks): 95 pass, 0 fail; SC-37 blocked (needs a collected staging run with signed-in checks — satisfied by this run's collection), TC-QA-007 skipped (local only).
- **Cart regression** (`order-lifecycle -g "TC-CART-001|TC-CART-002"`): **blocked** — not by the site or its stock (the shop has stock: Bread 87, others 99+), but by the suite helper `sellable()` (`tests/qa/lib/flows.ts`), which still reads `onlineStock` from the public storefront API; since D-90 customers get `inStock` instead, so the helper finds no product. The purchase-lists checks exercised the cart through the app (TC-LIST-016/017/018/021/022 pass) and single-request add / read / empty of `/api/cart` all answered 200.
- **Spec change for D-90:** the purchase-lists spec reads stock the way the app tells a customer (a throwaway "QA PL" list asks for 99 of each tracked product and its check says "Only N left in stock."), so TC-LIST-014 and 020 run on the new build (Bread: 87 left).
- **Test data:** only "QA PL …" lists (all deleted; none left on either account); carts restored to how they were (both empty at the end); no order, no payment.

## Production run (gokesari.com, 24 Oct 2026, 16:06–16:20 UTC) — guest tier only

The release was checked from outside, as a guest: `tests/qa/guest` (110 checks with the phone repeats, 14.5 min). Nothing signed in, wrote, ordered or paid; signed and local checks are recorded "not run on production".

- **Purchase lists — all pass:**
  - TC-LIST-001 (desktop and phone): `/lists`, `/lists?kind=MEDICINE`, `/lists/<unknown id>` and `/lists/not-a-list-id` all answer 307 → /signin, and the browser lands on the sign-in page.
  - TC-LIST-002: all 11 method/route pairs of `/api/purchase-lists` answer 401 UNAUTHENTICATED with a plausible body (no field errors, no 404 that would tell whether a list exists).
  - TC-LIST-006, guest half (desktop and phone): a shop page (/shops/agtci-yivu6, 6 product cards) shows no "Add to list" to a guest.
  - The guest write sweep (TC-SEC-001 / TC-RBAC-002) now covers 321 write endpoints (313 this morning): the 8 new purchase-lists write endpoints all refuse a guest.
- **Whole guest tier: 85 pass, 11 fail, 1 skipped** (TC-QA-007, local only). **All 11 failures are pre-existing, not new:** they are exactly the 11 rows that failed on production in this morning's baseline (`docs/testing/qa-runs/2026-10-24-production-guest-baseline.json`, 08:36 UTC). No new failure, and none of them changed. Their fixes (D-01 … D-06, PR #228) are on staging, where the same checks pass today, but not on main, which carries only purchase lists:

  | Case(s) | What production does | Defect (fixed on staging by #228) |
  |---|---|---|
  | TC-RBAC-002, TC-SEC-001 | The same 17 session-protected write endpoints read the request before refusing a guest (422 / 404 instead of 401); none of them is a purchase-lists route | D-01 |
  | TC-DISC-007, TC-SEC-002 | `/api/shops/abc/products` and other malformed ids answer 500 | D-02 |
  | TC-SEC-005, TC-SEC-010 | `X-Powered-By: Next.js` is still sent | D-03 |
  | TC-LOC-002, TC-FLD-020 | The location dialog accepts the invalid PIN "011001" instead of staying open with the error | D-04 |
  | TC-DISC-004, TC-DISC-007, TC-FLD-022 | Shop search by PIN "411014" finds nothing | D-06 |

## Results per case

| Case | Pri | What | Local (49ba367) | Staging (487f11b) | Staging detail |
|---|---|---|---|---|---|
| TC-LIST-001 | P0 | Guest is sent to sign-in from My lists and from a list's page | D: pass, M: pass | D: pass, M: pass | /lists → 307 /signin; /lists?kind=MEDICINE → 307 /signin; /lists/00000000-0000-4000-8000-000000000000 → 307 /signin; /lists/not-a-list-id → 307 /signin; browser lands … |
| TC-LIST-002 | P0 | Every purchase-lists API refuses a caller without a session | D: pass | D: pass | 11 method/route pairs, all 401 UNAUTHENTICATED: GET …, POST …, GET …/[id], PATCH …/[id], DELETE …/[id], GET …/[id]/check, POST …/[id]/items, PATCH …/[id]/items/[itemId… |
| TC-LIST-003 | P0 | Create a weekly shopping list | D: pass, M: pass | D: pass, M: pass | "QA PL mvmja44a Weekly dairy" created from the form → /lists/9dbe5b2c…, empty ("Browse shops"), SHOPPING/WEEKLY/remind on, next due +7 d, card under Shopping lists |
| TC-LIST-004 | P1 | Create a monthly medicine list with the reminder off | D: pass | D: pass | "QA PL mvmja44a BP medicines" MEDICINE/MONTHLY/reminder off; empty list links "Find a pharmacy" → /shops?type=PHARMACY; card under Medicine lists |
| TC-LIST-005 | P1 | A second list with the same name is refused (any case, extra spaces) | D: pass | D: pass | "QA  PL  MVMJA44A  MONTHLY  GROCERIES" (form) and "qa pl mvmja44a monthly groceries" (API, 409) refused: "HTTP 409: You already have a list called "qa pl mvmja44a mont… |
| TC-LIST-006 | P0 | Add to list from a product card | D: pass, M: pass | D: pass, M: pass | Burger Bun (E2E Four Features Bakery) → picker → "QA PL mvmja44a Card picks": 201, "Added to …", Open → the list shows it ×1 |
| TC-LIST-007 | P1 | Create & add a new list from the product card's sheet | D: pass | D: pass | "QA PL mvmja44a Made in picker" created in the sheet as a medicines list with Burger Bun ×1 |
| TC-LIST-008 | P1 | A product already on the list is left as it is ('Already on') | D: pass | D: pass | picker → 200 "Already on …"; API add ×7 → 200 alreadyOnList; still one line ×3 with its note |
| TC-LIST-009 | P1 | Only products customers can see can be added | D: pass | D: pass | unknown id → HTTP 404: Product was not found.; malformed → 422 VALIDATION_FAILED; list still empty |
| TC-LIST-010 | P0 | Quantities: stepper, typed value and skip (0) | D: pass, M: pass | D: pass, M: pass | Burger Bun 1→2 (+), typed 5; Bread 1→0 "Skipped this time", kept; "1 of 2" to order; estimate ₹150; kept after reload; card "2 products · 1 skipped" |
| TC-LIST-011 | P1 | Notes are saved; quantities 0-99 and notes up to 120 characters | D: pass | D: pass | note saved on leaving the field and kept after reload; quantity 100 → 422, quantity -1 → 422, quantity 1.5 → 422, a 121-character note → 422; 99 and 120 characters acc… |
| TC-LIST-012 | P1 | Remove a product from a list | D: pass | D: pass | Bread removed (204), gone after reload, Burger Bun kept; second remove → 404 |
| TC-LIST-013 | P0 | Check list shows the list priced like the cart | D: pass, M: pass | D: pass, M: pass | Burger Bun ×2 at ₹30: subtotal ₹60 + delivery ₹20 = total to pay ₹80 (dialog = API); Bread listed as skipped; cart and list unchanged |
| TC-LIST-014 | P1 | Check list shows the lines that will be left out, with the reason | D: pass | D: pass | Bread ×88 (stock 87) shown "Only 87 left in stock." priced "—", alert "1 product … left out"; total ₹50 = Burger Bun only |
| TC-LIST-015 | P1 | Check with items already in the cart: add to them or replace the cart | D: pass | D: pass | cart with Bread ×1: "Your cart already has 1 item", ADD default with "Total for this list" + note; REPLACE → "Total to pay"; cart unchanged |
| TC-LIST-016 | P0 | Confirm order with an empty cart | D: pass, M: pass | D: pass, M: pass | confirmed → /cart with Burger Bun ×2 (Bread skipped, not added); cart total ₹80 = checked total; list last ordered now, next due +7 d; no new order |
| TC-LIST-017 | P0 | Confirm order: add the list to a cart that has items | D: pass | D: pass | cart Bread ×1 + Burger Bun ×1, list Burger Bun ×2 → ADD: Bread ×1 kept, Burger Bun ×3; 4 units |
| TC-LIST-018 | P0 | Confirm order: replace the cart with the list | D: pass | D: pass | cart Bread ×1 → REPLACE with Burger Bun ×2: the cart holds only Burger Bun ×2 |
| TC-LIST-019 | P0 | Nothing to order is refused | D: pass | D: pass | Check list disabled with "Set a quantity above 0…"; all-skipped ADD → 422, all-skipped REPLACE → 422, empty REPLACE → 422 ("Nothing to order…"); cart still Bread ×1 |
| TC-LIST-020 | P1 | No line can go in: the cart is left exactly as it was | D: pass | D: pass | cart Butter Khari ×99, list ×1 → "Nothing could be added", "Your cart was not changed", left out "Butter Khari — Your cart already has 99…"; cart still ×99; list not m… |
| TC-LIST-021 | P1 | Save the cart as a new list | D: pass, M: pass | D: pass, M: pass | /cart → "QA PL mvmk8nvw From my cart" (SHOPPING, WEEKLY) with Burger Bun ×2, Bread ×1; "Saved to …", Open the list; offered in "Save to" without reload; cart unchanged |
| TC-LIST-022 | P1 | Save the cart into an existing list | D: pass | D: pass | "QA PL mvmk8nvw Existing list" had Burger Bun ×5 and Butter Cookies ×3; cart Burger Bun ×2 + Bread ×1 saved into it → Burger Bun ×2, Bread ×1, Butter Cookies ×3 kept; … |
| TC-LIST-023 | P1 | Edit a list's name, type, frequency and reminder | D: pass | D: pass | taken name refused ("You already have a list called…"); renamed to "QA PL mvmjud45 Edited meds", MEDICINE, WEEKLY, reminder off; next due +7 d; card moved to Medicine … |
| TC-LIST-024 | P1 | Delete a list | D: pass | D: pass | "QA PL mvmjud45 To be deleted" (1 product): Delete list → "Delete this list?" → Yes → /lists without it; page 404, API 404 |
| TC-LIST-025 | P0 | Another customer's list is not found | D: pass | D: pass | 8 API calls as customer 2 → 404; malformed id → 404; page 404; not in customer 2's lists; customer 1's list unchanged |
| TC-LIST-026 | P1 | Ways into My lists | D: pass, M: pass | D: pass, M: pass | account menu; account dropdown → Orders → My lists; /orders tab → /lists |
| TC-LIST-027 | P1 | Phone layout of the lists and the Add to list sheet | D: pass, M: pass | D: pass, M: pass | desktop 1280px: /lists, the list and its check fit; side Check list, no bar; sheet inside the screen, long name in full, 44px tap targets |
| TC-LIST-028 | P2 | Reminder when a list is due again | D: manual (recorded blocked by design) | D: manual (recorded blocked by design) | not automated: time-based: needs a list last ordered a week / a month ago and the 05:00 IST cron run (purchase-list-reminders) — local tier with the database; covered … |

D = desktop (1280 px), M = phone (Pixel 7, 412 px). TC-LIST-020 has two checks (the 99-per-line cap; REPLACE with nothing orderable), both pass.

## Defects

| ID | Severity | Where | What | Status |
|---|---|---|---|---|
| D-100 | Medium | Cart (`src/server/services/cart.ts`, addToCart) — not purchase lists | Two simultaneous "add to cart" of the same product: on a new line one answers 500 INTERNAL (5 of 5 rounds; the failing request writes nothing); on an existing line both answer 200 but one add is lost (1 + 2 + 2 saved as 3). One request at a time, any product, quantity 1 or 2: always 200; reading the cart is fine. Read-then-write outside a transaction; the unique index `cart_items_cart_product_unique` turns the second insert into an unhandled error. | Open |
| D-101 | Medium | Site header (signed-in, wide screens) — not purchase lists | The header search input is 0 px wide at 1024–1600 px and the "Search by voice" button lies over the "Shops" link (a click on "Shops" hits voice search). Predates this release (its only header change is the "My lists" menu entry). | Open |

Details, evidence and suggested fixes: `docs/testing/qa-defects.json`.

## Not covered here

- TC-LIST-028 (daily reminder) — time-based; declared manual; covered by `tests/integration/purchase-lists.test.ts`.
- gokesari.com — only the guest half of the feature (TC-LIST-001, 002, 006) can be checked there; production is read-only for QA (no sign-in, no lists, no cart).

## Where the files belong (owner's Mac)

This was a cloud session; nothing was saved to the Mac. Save these in `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking`: this file, `test-cases.xlsx`, `docs/testing/qa-runs/2026-10-24-*-purchase-lists*.json` (local, staging, production) and `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx` (rebuilt after the production run from every run in `docs/testing/qa-runs`; its statuses are written back into `test-cases.xlsx`).
