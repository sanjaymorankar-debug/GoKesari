# Guest cart — sign in only at "Place order" (23-Nov-2026)

Owner request, 23-Nov-2026: *"Check if it is mandatory for a customer to sign in before making any order? Ask the customer to sign in only when he is going to raise an order."*

## Before (found 23-Nov-2026, both sites)

Browsing, search, shop pages and product pages were open to guests, but **"Add to cart" sent a guest to sign-in** and the item was not added. `/cart`, `/api/cart*` and `/api/checkout` needed a session. Lists, wishlist and orders needed sign-in too.

## Now (flag `guest_cart_enabled`, Admin → Feature flags; missing row = off)

| Step | Guest |
|---|---|
| Add to cart (product cards, home tiles) | Added to a cart kept **in the browser** (`localStorage` `gk_guest_cart_v1`); nothing saved on the server |
| Header / phone cart badge | Counts the browser cart |
| `/cart` | Shows the guest cart, priced live by `POST /api/cart/preview` (same prices, offers and delivery fees as a signed-in cart) |
| Place order | "Sign in to place order": sets the return-to cookie to `/cart`, opens `/signin` |
| After sign-in | `GuestCartMerge` (root layout, signed-in users) posts the lines to `POST /api/cart/merge` once, clears the browser copy, and the customer lands on `/cart` checkout |
| Lists, wishlist, "Add to list", orders, checkout | Sign-in only, unchanged |

Flag off: everything behaves as before (`/cart` → sign-in, the preview answers 404, cards send a guest to sign-in).

## Owner decisions (23-Nov-2026, "Yes, use defaults")

1. Guest cart kept in the browser, not on the server (no migration, no clean-up job).
2. Merge: quantities are **added** to the account cart, capped at the per-line maximum (99) and the shop's stock; a line that cannot be bought any more is dropped, and the customer is told which.
3. Limits: 50 different items, kept 7 days. The per-IP API limit in `src/proxy.ts` (240/min) covers the preview.
4. Lists / wishlist / "Add to list" stay sign-in only.
5. Flag ON on staging for testing; production only with the owner's OK, in the 23.00 IST window.

## Code

- `src/lib/guest-cart.ts`: browser cart rules (limits, TTL, add / set)
- `src/server/services/guest-cart.ts`: `previewGuestCart`, `mergeGuestCart`
- `src/app/api/cart/preview/route.ts` (public, flag-gated), `src/app/api/cart/merge/route.ts` (session + flag)
- `src/components/guest-cart/*`: context, cart view, merge-on-sign-in
- `src/app/cart/page.tsx`, `src/app/layout.tsx`, `product-card.tsx`, `home/product-tiles.tsx`, `site-header.tsx`, `home/mobile-shop-nav.tsx`

## Tests

- Unit: `tests/unit/guest-cart.test.ts`
- Integration: `tests/integration/guest-cart.test.ts`, `tests/integration/guest-cart-route.test.ts`
- Guest QA: `tests/qa/guest/guest-cart.spec.ts` (TC-GCART-001..003); `/cart` added to `PUBLIC_PAGES`, `/api/cart/preview` to `PUBLIC_WRITES`
