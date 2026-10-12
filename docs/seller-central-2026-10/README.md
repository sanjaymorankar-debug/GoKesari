# GoKesari Seller Central (2026-10)

Every shop registration and shop-owner activity now has a portal of its own,
apart from the shopping site. It is modelled on Amazon's seller experience:
**sell.amazon.in** became the public page `/sell`, and **sellercentral.amazon.in**
became the Seller Central frame around every `/shop/…` page.

## What changed

| Area | Before | Now |
|---|---|---|
| Public seller page | None. "Sell on GoKesari" went straight to the `/shop/register` form | **`/sell`**: hero, benefits, how it works (4 steps), Seller Central tools, shop types, the ways to register, a checklist of what to keep ready, FAQ, its own seller header and footer |
| Shop owner pages (`/shop/…`) | Inside the shopping site's header (cart, deliver-to, wallet) and footer | Inside **Seller Central**: a dark seller top bar and a grouped sidebar. The shopping header and footer are hidden on these pages |
| Seller home (`/shop`) | Tile board with 16 tiles | A dashboard with sections for action required, orders to work on, performance over the last 30 days, the shop wallet, items that need a look, account health, and all seller tools |
| No shop yet (`/shop`) | One "Add my shop" button | Welcome page with both ways to register side by side |
| Menu pages (`/shop/menu/…`) | "Back to board" | "Back to Seller Central" |
| Entry points | `/shop/register` | Footer "Sell on GoKesari", the home page's join row and the invite-a-shop card all lead to `/sell`. The header button for shop owners now reads "Seller Central" |

All URLs under `/shop/…` are unchanged, so notification links, the mobile app,
saved bookmarks and tests keep working.

## Seller Central frame

- **Top bar** (`src/components/seller/seller-shell.tsx`): GoKesari Seller Central
  logo (links to the seller home), the shop's name and a status pill (Live,
  Pending approval, Suspended, Rejected or Inactive), "View my store" once the
  shop is live, the language switch (EN / हिं / मरा), notifications, and the
  account menu. The account menu has the role switcher, profile, seller help,
  seller terms, a link back to the shopping site, and sign out.
- **Sidebar**: the 16 shop owner menus grouped by job. A live badge sits next
  to each menu, and the menu for the open page expands to show its sub-pages.
  On phones the sidebar is a drawer behind the ☰ button.

  | Group | Menus |
  |---|---|
  | Orders | Orders, Returns, Disputes, Delivery staff |
  | Catalogue | Inventory, Price updates, Photo catalogue, Product categories |
  | Payments | Finance, Wallet, Payout bank |
  | Growth | Marketing, Offers, Analytics |
  | Account | My Shop, Legal documents |

- **Find a tool**: a search box at the top of the sidebar that filters every
  menu and sub-page as you type, in any of the three languages.
- Menu labels, links, icons, badges and permissions still come from one place,
  `SHOP_MENUS` in `src/lib/board/menus.ts`. The grouping lives in
  `src/lib/seller/nav.ts`, and a unit test fails if a menu is left out of the
  groups.

## Seller home sections (`/shop`)

1. **Action required**: every account alert, most serious first (suspension,
   rejection, wallet recharge, legal documents, approval stage, payout bank).
   These are the same rules as before, but all alerts show now, not just the
   first two.
2. **Orders to work on**: New, Packing, Ready and Out for delivery. Each one
   links to its filtered order list.
3. **Performance — last 30 days**: sales, orders, delivered, repeat customers,
   fill rate, on-time rate and cancellation rate. These figures come from the
   same service as `/shop/analytics`. The card is shown only to roles that may
   see shop reports.
4. **Shop wallet**: the balance, linking to the wallet page.
5. **Needs a look**: low stock, return requests, open disputes and price requests.
6. **Account health**: shop verification, payout bank and legal documents,
   each marked Good or Needs action.
7. **All seller tools**: one card per menu, with its sub-pages as chips.

## Files

- `src/app/sell/page.tsx`: the public "Sell on GoKesari" page.
- `src/app/shop/layout.tsx`: wraps every `/shop/…` page in Seller Central.
- `src/components/seller/seller-shell.tsx`: top bar, sidebar, drawer and tool search.
- `src/components/seller/seller-home.tsx`: the seller home dashboard.
- `src/components/seller/register-options.tsx`: the two ways to register (used on `/sell` and on `/shop` before a shop exists).
- `src/lib/seller/nav.ts`: sidebar groups and Seller Central wording in EN, HI and MR.
- `src/app/globals.css`: hides the shopping header and footer while Seller Central is on screen.
- `src/server/board-data.ts`: `loadShopCounts`, so the shop's counts are read only once per request even though both the layout and the page use them.
- `src/components/board/shop-board.tsx`: removed, replaced by the seller home.
- `mobile/app.config.ts`: `/sell` added to the paths that open in the Android app.
- `tests/unit/seller-central.test.ts`: checks the sidebar grouping, permission filtering, all three languages and the status pill.

## Test results

See [TEST_RESULTS.md](TEST_RESULTS.md).
