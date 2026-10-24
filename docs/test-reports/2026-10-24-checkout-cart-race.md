# Checkout and a cart change at the same moment — test results, 24 Oct 2026

Found while fixing D-100 (concurrent "add to cart"). Belongs in the owner's
`Test_Cases_Tracking` folder.

## The race

`checkout` (`src/server/services/orders.ts`) read the cart once, outside any
transaction, ordered each line's quantity from that read, and at the end of
each shop's transaction removed every line of that shop as it was *then*
(`clearCartForShop`). Units added in between — a second tab, the app — were
removed from the cart without being ordered.

## The fix

- Each shop's transaction first takes the cart's lock (`lockCart`, the lock an
  add, a quantity change and a purchase list's send already take since D-100)
  and reads the shop's lines again under it (`lockCartLinesForShop`,
  `src/server/services/cart.ts`).
- The order is made from those lines, and exactly those lines leave the cart
  (`removeCartLines`). An add before the lock is ordered; an add after it waits
  for the order to commit and stays in the cart.
- The shop's minimum order is checked again on the lines ordered (the cart may
  have been lowered since the first check).
- A double submit (same request id) that waited for the lock finds the order
  the first one placed and returns it, instead of failing on
  `orders_checkout_key_unique`.
- Two checkouts of the same cart from two tabs no longer order it twice: the
  second finds nothing left from the shop and is refused with a clear message.
- Lock order: the cart's lock is taken before any slot, coupon, stock or wallet
  lock, and its other holders take none of those, so it adds no deadlock.
  Payment-gateway calls stay outside the transaction (`startOnlineCheckout`
  calls the gateway after `checkout` returns).

## Test: `tests/integration/checkout-cart-race.test.ts`

The concurrent change is started at 12 steps across one checkout's measured run
(0 % … 110 %), so it lands before, inside and after the shop's transaction.

| Test | Before the fix | After the fix |
|---|---|---|
| Add the same product while checkout runs (wallet) | **Fails** — 2 ordered, 0 left in cart (3 units lost) | Passes: 5 ordered, or 2 ordered + 3 left |
| Add another product of the same shop (wallet) | **Fails** — 0 rolls ordered, 0 in cart (4 lost) | Passes: ordered and paid for, or left in cart |
| The same two, paid online (order waits in PENDING) | **Fail** — units lost | Pass |
| Two checkouts of one cart from two tabs | **Fails** — cart ordered twice | Passes: one order, the other refused (409) |
| Double submit, same request id, at once | **Fails** — 500 on `orders_checkout_key_unique` | Passes: one order, both answers carry it |
| Quantity lowered while checkout runs | **Fails** — the lowering is lost (4 ordered, line gone) | Passes: ordered as lowered, never under the minimum |

Before = 7 of 7 fail on both layouts; after = 7 of 7 pass on both layouts.

## Full suite (`npm test`)

| Where | Layout | Result |
|---|---|---|
| CI `test`, commit `4c042c9` | One database | Pass |
| CI `test-split`, commit `4c042c9` (blocking) | Seller / customer split (`DB_SPLIT_MODE=split`, built with `scripts/db-split/test-layout.ts`) | Pass |
| Local, commit `8086328` | One database | 2,620 passed, 1 failed: `gst-compliance` "sorts sales into B2B, B2C large…" |

The one local failure is not from the checkout change. The D-100 base (#240) caps a
cart line at 99 units, and that test orders 300 on one line; it fails the same way
without the checkout change. `4c042c9` carries the test change from #241 (99 units
at ₹1,020), and the file passes on both layouts (11 of 11).

Local PostgreSQL 16 and CI PostgreSQL 18, Node 22.
