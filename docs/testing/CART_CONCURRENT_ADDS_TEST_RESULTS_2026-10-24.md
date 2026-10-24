# Simultaneous "add to cart" (TC-CART-001): test results (24 Oct 2026)

The concurrent add-to-cart defect found by the QA run of 24 Oct 2026 on
test.gokesari.com (cases TC-CART-001, TC-LIST-021): two `POST /api/cart` of the
same product at the same moment. PR #239 logs it as D-100, but `staging`'s
`docs/testing/qa-defects.json` already uses D-100 for another defect
(product-master promotion, #244), so its number changes when #239 is merged.
Fixed by PR #240.

| Case | Before the fix | After the fix |
|---|---|---|
| Empty cart, adds at the same time | one 200, the other **500** (`cart_items_cart_product_unique`) | all 200, line = the sum |
| Existing line 1, + 2 and + 2 at the same time | both 200, saved **3** (one add lost) | both 200, saved 5 |

## Fix

`src/server/services/cart.ts`: `lockCart(userId, tx)` gets (or creates) the
cart and locks its `carts` row `FOR UPDATE`. `addToCart` and
`setCartItemQuantity` now run in `db.transaction` and take that lock before
reading the line, so simultaneous changes run one after the other. Stock is
checked against the resulting quantity inside the transaction. A line stops at
99 (`CART_LINE_MAX_QUANTITY`, the cap the cart API already applies to one
request). `sendPurchaseListToCart` takes the same lock: a list sent while an
add was in flight also lost units (3 or 4 saved instead of 6).

`carts` and `cart_items` are customer (core) tables, so the lock is a core lock
on both layouts. The transaction only reads seller rows (stock, shop status)
and writes none, so it never meets the split layout's 40001.

The 99 cap is a behaviour change. Repeated adds used to push a line past 99,
and service-level callers could add any amount. One test relied on that:
`tests/integration/gst-compliance.test.ts` (GSTR-1 export) put 300 ghee on one
line to make a B2C large invoice. It failed on both CI jobs of the first push,
and now builds the same ₹1,00,800 invoice as 30 × ₹3,360.

## Integration test — `tests/integration/cart-concurrent-adds.test.ts`

| # | Test | Before the fix | Single DB | Split (core + seller) |
|---|---|---|---|---|
| 1 | No cart yet: 2 + 2 + 3 at once → all 200, line 7 | Fail: `[200, 200, 500]` | Pass | Pass |
| 2 | Empty cart: 2 + 2 + 3 at once → all 200, line 7 | Fail: `[500, 500, 200]` | Pass | Pass |
| 3 | Existing line 1, + 2 and + 2 at once → both 200, line 5 | Fail: lost update | Pass | Pass |
| 4 | Line 95, + 3 three times at once → all 200, line 99 | Fail: no cap | Pass | Pass |
| 5 | Stock 4, + 3 and + 3 at once → one 200, one 409 "Only 4 left in stock.", line 3 | Fail: `[200, 500]` | Pass | Pass |
| 6 | Line 1, PATCH to 5 and + 2 at once → 5 or 7, never 3 | Fail: 3 | Pass | Pass |
| 7 | Line 1, list (2) sent and + 3 at once, add delayed 0–12 ms over 7 rounds → 6 every round | Fail: 3 or 4 (probe) | Pass | Pass |

Each layout was run three times in a row: 7 / 7 every run.

## Whole suite (`npm test`)

| Run | Commit | Test files | Tests | Result |
|---|---|---|---|---|
| Local, single database | `df25206` | 206 passed, 1 failed | 2,610 passed, 1 failed | Only failure: the GSTR-1 test above (fixed in `1f5a43b`) |
| Local, single database, GSTR-1 file alone after the fix | `1f5a43b` | 1 passed | 11 passed (3 runs) | Pass |
| Local, split (`DB_SPLIT_MODE=split`, built with `scripts/db-split/test-layout.ts`) | `1f5a43b` | 206 passed, 1 skipped | 2,603 passed, 8 skipped | Pass |
| CI `test` (single database, PostgreSQL 18) | `1f5a43b` | — | — | Pass |
| CI `test-split` (split, PostgreSQL 18) | `1f5a43b` | — | — | Pass |

The 8 skipped tests are `tests/integration/db-split.test.ts`, which skips
itself on the split layout (the same in CI).

Local PostgreSQL 16 (CI runs 18). Typecheck (`tsc --noEmit`) and ESLint on the
changed files: clean.

Not covered here: re-testing on test.gokesari.com once this is deployed (the QA
agent's TC-CART-001 race check).
