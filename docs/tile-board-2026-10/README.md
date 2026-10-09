# Tile Board home screens ("Theme 1 Tile Board")

The approved design for the four role home screens, built from the five
approved mockups (customer desktop 1366×768; shop owner, admin, operator and
customer-in-Marathi at 360×800).

| Role | Route | What the first screen holds |
|---|---|---|
| Customer (and signed-out visitors) | `/` | search, live order banner, tomorrow's subscription banner, 8 category tiles, 6 menu tiles (18 submenus), cart bar; wide screens add "Buy again" |
| Shop owner | `/shop` | "Do now" strip (New orders, Returns, Low stock) and 16 menu rows (39 submenus) |
| Admin | `/admin` | "Do now" strip (Approvals, Reviews, Refunds) and 9 tiles (39 submenus) |
| Operator | `/admin` | two alert banners (only when there is something to act on) and 6 tiles (22 submenus) |

The first screen is the board; everything each page had before follows below
it, unchanged. All other pages keep the site header exactly as before.

## How it is built

| Piece | File |
|---|---|
| Menus for all four roles: label ×3 languages, icon, link, live-count key, permission | `src/lib/board/menus.ts` |
| Language (cookie `gk_lang`, parsing, board wording in EN/HI/MR) | `src/lib/board/i18n.ts`, `src/server/board-lang.ts`, `src/server/language-action.ts` |
| Badge and money formatting | `src/lib/board/format.ts` |
| Live counts (read-only, every query time-boxed and caught) | `src/server/services/board-counts.ts`, `src/server/board-data.ts` |
| Compact header (56 px on phones) | `src/components/board/board-header.tsx`, `src/server/board-header-data.ts` |
| Tiles, chips, badges, banners | `src/components/board/tiles.tsx` |
| The four boards | `src/components/board/{customer,shop,staff}-board.tsx`, `buy-again.tsx` |
| Icons (Lucide 0.460.0, ISC — notice kept in the file) | `src/components/board/icons.tsx` |
| Hiding the site header while a board is on the page | `src/app/globals.css` (last rule) |

- **Language.** EN / हिं / मरा is a form posting to a server action: it stores
  the cookie and re-renders the page on the server in that language (works
  before JavaScript loads). Only board labels are translated; shop, product
  and place names are shown as entered. The board carries `lang="hi-IN"` /
  `"mr-IN"` so screen readers pick the right voice.
- **Live figures only.** Every number is a database read. A query that fails
  or takes over 4 s is dropped — that badge simply does not show. Zero shows
  no badge. No mockup numbers are used anywhere.
- **Permissions.** Each entry names the permission from
  `src/server/authz/permissions.ts` that the page it opens checks; entries a
  role may not open are hidden, and a tile left with none is hidden. Pages
  that check `role === "ADMIN"` themselves are gated with `SYSTEM_CONFIG`
  (admin-only). A tile links to its own page only when that page is one of
  its permitted entries. The pages keep their own server-side checks.
- **No migrations, no new dependencies.**

## Substitutions (mockup entry has no feature behind it today)

Built as the nearest real destination, honestly named, in the same position.
The owner can decide later whether to build the missing feature.

| Role | Mockup entry | Shown instead | Link |
|---|---|---|---|
| Customer | Shops → Favourites | **Delivers here** (phone: "Delivers") | `/shops?delivery=true` |
| Customer | Profile → App theme | **Bank account** (phone: "Bank") | `/profile/bank-account` |
| Customer | Tracking → Call rider (rider's number is deliberately not shown to customers) | **Delivery code** (phone: "OTP code") | `/orders` |
| Shop owner | My Shop → Theme | **Staff** | `/shop/staff` |
| Operator | Riders → Earnings (rider earnings rules are admin-only; `/admin/rider-earnings` sends operators home) | **Pay issues** | `/admin/finance/exceptions` |
| Admin | Shops → Verified | **Verification** (the review queue for seller documents) | `/admin/seller-verification` |
| Admin | Settings → Alerts | Alerts = the live operations-exceptions queue | `/admin/exceptions` |
| Customer | Category "Household" (there is no household shop type) | Household → supermarkets | `/shops?type=SUPERMARKET` |

## Chips that share a destination (the page has no filter for them)

| Role | Chips | Page |
|---|---|---|
| Customer | Orders → Active, Past; Tracking → Delivery code | `/orders` |
| Customer | Subscriptions → Calendar, Pause | the customer's latest active subscription `/subscriptions/{id}` (`/subscriptions` when there is none) |
| Shop owner | Orders → New, Packing, Ready, Out; Delivery staff → Assign | `/shop/orders` |
| Shop owner | Returns → Requests, Pickups | `/shop/returns` |
| Shop owner | Disputes → Open, Resolved | `/shop/disputes` |
| Shop owner | Inventory → Stock, Low | `/shop/inventory` |
| Shop owner | Wallet → Balance, History | `/shop/wallet` |
| Shop owner | Payout bank → Details, Verified | `/shop/bank-account` |
| Shop owner | Offers → Active, New | `/shop/offers` |
| Shop owner | Analytics → Sales, Top items (`?days=30`) | `/shop/analytics` |
| Shop owner | Price updates → Edit, Requests (`#price-requests`) | `/shop/prices` |
| Admin | Users → Customers, Owners, Staff; Privileges → Roles, Perms | `/admin#users` |
| Operator | Riders → On duty, Applications | `/admin#delivery-partners` |
| Operator | Societies → Members, Society riders | `/admin/societies?status=VERIFIED` |
| Operator | Vouchers → Vouchers, Redemptions | `/admin#vouchers` |

Where a page section could be reached directly, an `id` was added to it so
the chip scrolls there (see "Existing files touched").

## Differences from the mockups, and why

- **Phone header has an account button** (initial in a circle). The mockups
  show none, but the account menu (profile links, role switcher, sign out)
  has to live somewhere on the one-row header.
- **No microphone in the search box.** There is no voice search.
- **Order banner** shows the order number, status and shop. The mockup's
  rider name, distance and arrival time are not shown: customers are not given
  rider details, and there is no arrival estimate. The Tracking tile's
  "8:40" headline is the order number on wide screens and blank on phones.
- **Tomorrow's banner** has no "6–7 AM" window (subscriptions have no delivery
  window); it shows the product, quantity, cost from wallet and the change-by
  time (only while changes are still allowed).
- **Phone customer tiles show only urgent (red) chip counts**, as the mockup
  does; the tile header carries the total. All counts show on wide screens.
- **Five English chip labels are shortened on phones** so they are not cut
  off: Delivers here → Delivers, Add money → Top up, Delivery code → OTP code,
  Refer & earn → Refer, Bank account → Bank. Hindi and Marathi are unchanged.
- **Category emoji** are the system's emoji font (Android shows Noto), not the
  mockup's rendered images.
- **Desktop for shop owner, admin, operator** (no mockup): the same tiles and
  chips; chips flow in rows inside each tile. Shop owner: two columns of eight
  rows. Admin 3×3, operator 3×2.

## Existing files touched (additive)

| File | Change |
|---|---|
| `src/app/page.tsx` | Board mounted first; the hero search (now in the board) removed; tomorrow card, shop list, price comparison and sign-up cards kept below in the old container |
| `src/app/shop/page.tsx` | Board mounted first; existing dashboard below; ids `excel-upload`, `location`, `products` |
| `src/app/admin/page.tsx` | Board mounted first; existing console below; ids `delivery-partners`, `grievances`, `product-approvals`, `users`, `vouchers`, `voucher-upload`, `audit-log` |
| `src/app/globals.css` | Two rules: hide the site header and drop `<main>` padding only while a board is on the page |
| `src/app/orders/page.tsx` | id `order-{number}` on each order card (Track / Live map) |
| `src/app/profile/page.tsx` | id `notifications` (bell) |
| `src/app/shop/finance/page.tsx` | ids `settlements`, `invoices` |
| `src/app/shop/prices/page.tsx` | id `price-requests` |
| `src/components/shop-approval-panel.tsx` | id `approved-shops` (Grade / Quality grade) |
| `src/components/wallet-view.tsx` | ids `add-money`, `history` |

## Mobile app

The app (`mobile/`, on `main`) shows the website in a native shell; the
preview build "GoKesari Test" loads test.gokesari.com and the production build
gokesari.com. The shell pads the status bar and the bottom system area itself
and injects only a JavaScript bridge, so the board appears in the app with the
website. **No app change and no new app build are needed.**

## Releasing to production

Merge `staging` into `main`. Nothing in this feature needs a migration,
setting or environment variable.
