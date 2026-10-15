# Order lifecycle on test.gokesari.com — 14 Oct 2026

The full order lifecycle run on staging (test.gokesari.com) through the API
and in a browser (Chromium, phone size): sign-up → wallet top-up (Cashfree
**sandbox**) → order → shop accepts and prepares → delivery → DELIVERED →
invoice and wallet charges. Production (gokesari.com) has not been run yet.
It waits on the owner (see the last section).

Test people (all on test.gokesari.com):

| Who | Account | Notes |
|---|---|---|
| Customer | `sanjaymorankar+gk-lc14@gmail.com` | New sign-up by an emailed link; mobile 9730141014 |
| Bakery owner | `sanjaymorankar+gk-shop@gmail.com` | 7 shops, including **E2E Four Features Bakery** |
| Stationery owner | `sanjaymorankar+gk-kirana@gmail.com` | **E2E Four Features Stationery** (delivery off) |
| Rider | `sanjaymorankar+gk-rider@gmail.com` | E2E Rider Vijay (approved) |
| Admin | `sanjaymorankar+gk-admin@gmail.com` | Shop wallet credit only |

Payments used Cashfree sandbox test data only (UPI `testsuccess@gocash`),
paid through the "Sandbox payment" workflow.

## Run 1 (TR-22): 16:01–16:23 UTC — PASS with open items

| # | Time (UTC) | Step | Result | Outcome |
|---|---|---|---|---|
| 1 | 16:01 | Sign up by emailed link; profile with mobile; two addresses (Shivajinagar, Baner) | Signed in; profile and addresses saved | PASS |
| 2 | 16:03–16:06 | Wallet top-up ₹200, Cashfree sandbox UPI (workflow run 38594861540) | Verified; wallet ₹200 | PASS |
| 3 | 16:07 | Order 1 **DB-20261014-ZQH9MI**, bakery, 2 × Bread, wallet | First try timed out at 30 s; retried with the same request id: one order, charged once (`deduplicated`) | PASS (slow, D-27) |
| 4 | 16:08 | Shop accepts → preparing → GoKesari rider, mark ready | READY; the rider was offered the delivery at once and accepted | PASS |
| 5 | 16:09–16:11 | Rider at the shop: read the pickup code on Seller Central → Orders | **Not shown**: the owner has 7 shops and Seller Central always showed the newest one, not the bakery | FAIL (D-24) |
| 6 | 16:14 | Shop switches the order to pickup | Rider released; ₹20 delivery fee refunded to the customer | PASS |
| 7 | 16:15–16:16 | Pickup code from My Orders: wrong code, then right code (8606) | 422 "4 attempts left", then DELIVERED; tax invoice | PASS |
| 8 | 16:20 | Order 2 **DB-20261014-QS7ZZ5**, stationery, GoKesari rider | 422 "delivery partners need delivery switched on" — correct; the test shop has delivery off | PASS (rule works) |
| 9 | 16:21–16:23 | Order 2 as pickup, code 9246 | DELIVERED | PASS |
| 10 | 16:23 | Shop wallets: 1% commission on each order; no delivery charge on pickups | As expected | PASS |
| 11 | — | Customer emails for each step | All received | PASS |
| 12 | 16:15 | My Orders card for order 1 after the switch to pickup | Still shows "Finding a rider · E2E Rider Vijay" | FAIL (D-25) |

## Run 2 (TR-23): 17:29–17:40 UTC, after PR #168 — PASS

PR #168 (shop switcher in Seller Central) was merged to staging at 17:28 and
was live on test.gokesari.com at 17:31.

| # | Time (UTC) | Step | Result | Outcome |
|---|---|---|---|---|
| 1 | 17:31 | Seller Central for the 7-shop owner | Top bar shows a shop switcher with all 7 shops | PASS |
| 2 | 17:32 | Choose **E2E Four Features Bakery** in the switcher; reload | Bakery shown; kept after reload (cookie `gk_shop`: Secure, HttpOnly, SameSite=Lax) | PASS |
| 3 | 17:29–17:31 | Wallet top-up ₹200, Cashfree sandbox UPI (workflow run 38607067429) | Verified; wallet ₹20 → ₹220 | PASS |
| 4 | 17:33 | Order 3 **DB-20261014-QKJX67**, bakery, 2 × Bread ₹80 + ₹20 delivery, wallet | Placed (₹100); wallet ₹220 → ₹120; checkout took **37.8 s** | PASS (slow, D-27) |
| 5 | 17:33 | Order on the bakery's Seller Central → Orders | Shown | PASS |
| 6 | 17:34 | Accept → preparing → GoKesari rider, slot Thu 15 Oct 7–8 am, mark ready | READY. Rider search scheduled for the slot's lead time (correct: today's slots were over) | PASS |
| 7 | 17:35 | Shop presses "find a rider now" | Rider offered the delivery | PASS |
| 8 | 17:36 | Rider accepts, arrives at the shop | Accepted; arrival recorded | PASS |
| 9 | 17:36 | Pickup code on the bakery's Seller Central → Orders | **Shown (4584)** — D-24 fixed | PASS |
| 10 | 17:36 | Rider enters a wrong pickup code, then the right one | 422 "does not match", then PICKED_UP | PASS |
| 11 | 17:36–17:37 | Rider starts, arrives at the customer; delivery code emailed (0598) | Code email received; "ask again" refused during the cool-down (429, 40 s) | PASS |
| 12 | 17:37 | Rider marks delivered without a photo | 409 "Take a photo of the order at the door" (photo proof rule on) | PASS |
| 13 | 17:38 | Rider uploads the door photo; wrong delivery code; right code | 201; 422 "4 attempts left"; **DELIVERED** at 17:38:18 | PASS |
| 14 | 17:39 | Bakery wallet | Commission ₹0.80 (1% of ₹80) and delivery charge ₹7.50 (1.51 km at ₹5/km): ₹965.70 → ₹957.40 | PASS |
| 15 | 17:39 | Customer My Orders | DELIVERED, ₹100, tax invoice, photo at delivery | PASS |
| 16 | 17:39 | Rider set offline | Offline | PASS |
| 17 | 17:40 | My Orders card for order 1 (pickup, delivered) | Still "Finding a rider · E2E Rider Vijay" (D-25); the ₹20 delivery-fee refund is labelled "refunded … for unavailable items" (D-26) | FAIL |

## Defects

| Defect | What | Status |
|---|---|---|
| D-24 | An owner with several shops saw only their newest shop in Seller Central, so another shop's orders and rider pickup code were not visible | Fixed in #168; re-checked in run 2 |
| D-25 | My Orders still shows "Finding a rider · \<rider\>" after the shop changed the order to pickup and it was delivered | Open |
| D-26 | My Orders labels the pickup delivery-fee refund (₹20) "refunded to your wallet for unavailable items" | Open |
| D-27 | Wallet checkout takes 30–38 s on test (one call timed out at 30 s; retry was safe) | Open |

## Test data changed on test.gokesari.com

- Stationery shop wallet credited ₹500 by the admin (so it can take orders).
- Bread at the stationery shop listed online at ₹50.
- The 7-shop owner's Seller Central is now set to the bakery (cookie only).
- Customer wallet ends at ₹120.

## Production (gokesari.com): not run yet

The owner chose a full order with a real payment and will provide:
- a production shop with delivery on, and its owner's sign-in email;
- an approved rider (or permission to register one for approval);
- confirmation that the Cashfree live keys are set;
- the real top-up, paid by the owner. No test data or sandbox keys are used on production.
