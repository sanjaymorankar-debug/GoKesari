# Mobile UX fixes — shop owner, admin console, iPhone (25-Nov-2026)

Owner brief: 25-Nov-2026, 21.10 IST ("audit and fix the usability of gokesari.com
and test.gokesari.com for every role, with special focus on the shop owner and on
iPhone"). Additions only; the approved "Theme 1 Tile Board" look and the Kesari
colours stay. The Android and iPhone apps show the website in a WebView
(`mobile/README.md`), so every change here reaches the installed apps with the
web deploy — no store release is needed.

## What changed

### A. Bulk price and stock editor (`src/components/shop-setup/stock-editor.tsx`)

Used by **My products** (`/shop/my-products`) and step 3 of product setup.

| # | Brief | Done |
|---|---|---|
| A1 | Inputs almost invisible | White fill, 1.5 px slate-500 border (4.7:1 on white; WCAG 1.4.11 needs 3:1), 16 px text, 48 px tall, 4 px Kesari focus ring, ₹ prefix inside MRP and price. Empty required boxes: amber fill + "Enter MRP" / "Enter price" placeholder. Errors: red border + red fill + message under the box. |
| A2 | 45 of 45 pre-selected | Nothing is selected at first. "Same stock" and "Discount off MRP" show only once rows are picked ("Change n selected products at once"). "Select all n" and "Clear selection" links. |
| A3 | "Pause selling" next to the badge | Moved into a ⋮ menu per row (44 px). Pausing asks first ("Pause selling …? Customers will not see it until you resume."); Resume is one tap. Toast confirms. |
| A4 | No save step / unsaved state | Sticky bottom bar: "n unsaved changes", **Discard**, **Save changes (n)** (disabled at 0). Edited rows get a Kesari left border and an "Edited" tag. Success toast. Leaving with edits (link, reload, close) asks first. The bar sits above the phone tab bar and the iPhone home bar. |
| A5 | Validation | Selling price ≤ MRP; MRP > 0; for packaged goods an MRP is needed once a price is set ("Enter the MRP to go live."). Only edited rows block the save (in setup, every row) — old gaps elsewhere never lock the button. Messages sit under the box and are tied to it (`aria-describedby`). |
| A6 | Units confusing | Each row says "150 g pack" (packaged) or "Sold per kg" (loose). Stock label says "Stock (packs)" or "Stock (kg)". A packaged product whose pack size was never filled ("1 g") shows "Pack size looks wrong — tell support the real size." The data-quality list is in the test report. |
| A7 | Filters, search, sort | Status tabs now read Needs Price · Live · Paused · Needs Stock · Out of Stock · All (one scrolling row on phones). Search box (name, brand, code, category) and Sort (category, needs action first, name, price, stock). |
| A8 | Phone cards | One card per product with labelled MRP / Selling price / Stock, 48 px − / + steppers, `inputmode="decimal"` (number keypad), `enterkeyhint="next"`. |
| A9 | Desktop fast entry | Tab follows MRP → price → stock along the row, then the next row; Enter does the same (spreadsheet-style); each box selects its value on focus. |

### B. Admin and operator console on phones (`src/components/board/staff-board.tsx`)

* Phones and tablets (below 1024 px) get a new 2-column grid (3 from 700 px):
  icon, the full title (wraps to two lines, never cut), and **one** count that
  says what it counts ("17 pending" in red for act-now items, "42 total"
  otherwise). The unexplained "+8 / +17" figures are gone from phone tiles.
* The tile opens its page; sub-actions there are now full-width rows on phones
  (`menu-hub.tsx`, 1 column below 480 px, each row ≥ 64 px).
* The board no longer squeezes into one fixed screen height on phones; it
  scrolls, so nothing is clipped.
* The shopping site's footer (Company, Make Money…) is hidden on the admin and
  operator consoles.
* Desktop (≥ 1024 px) is unchanged.

### C. Shop owner navigation and home

* **Bottom tab bar** on phones/tablets in Seller Central
  (`src/components/seller/seller-bottom-nav.tsx`): Home · Orders (red badge =
  new orders) · Products (amber badge = need a price) · Wallet · More (opens the
  full seller menu). Fixed above the iPhone home bar. Desktop keeps the sidebar.
* **Phone home** (`shop-board.tsx`): a large "New orders (n)" card first (Kesari
  when there are new orders), then **+ Add product** and **Update prices &
  stock**, then the "n products need a price" alert, then the wallet balance,
  then the 16 tiles (now scrolling, labels no longer clipped; "+6" reads "+6 more").
* **First-visit tour**: 3 steps (Orders → Products → Wallet), Skip at any time,
  shown once per browser (`localStorage gk-seller-tour-v1`); never shown to
  automated test browsers.
* New live count `shopNeedsPrice` (`board-counts.ts`).

### D. Every screen

* `viewport-fit=cover`, so `env(safe-area-inset-*)` works; the seller top bar,
  drawer and bottom bars pad for the notch and home bar; landscape keeps clear
  of the notch.
* On screens below 1024 px every text box, number box and select uses 16 px
  text — iOS Safari no longer zooms in when a field is tapped.
* Other sticky bottom bars under `/shop` (category picker, product picker, bill
  review, Health) sit above the tab bar (`--gk-bottom-nav`).

### E. Customer orders and delivery partner (follow-up, 25-Nov 22.10 IST)

* **Customer `/orders`:** document and help links on each order card are 44 px tall
  (14 px text, was 12 px and 16 px tall); rating stars are 44 × 44; Submit rating and
  Cancel order buttons are 44 px; the EN / हिं / मरा switch is 44 px everywhere.
* **Delivery partner:** a phone tab bar (`src/components/rider-bottom-nav.tsx`,
  `src/app/delivery-partner/layout.tsx`): Home · Earnings · Payouts · Documents ·
  Account. Earnings and Payouts jump to those sections of the home page and appear
  once the rider is approved; the bar is hidden while applying or registering and on
  the full-screen navigation map. Verification links and Reload are ≥ 44 px.

## Tap counts (Part 2C targets)

| Task | Target | Now (phone) |
|---|---|---|
| Open new orders from home | 1 | 1 — "New orders (n)" card (or the Orders tab from any page) |
| Accept an order | ≤ 2 | 2 — New orders card → "Accept order" on the order |
| Reach the add-product form | ≤ 2 | 1 — "+ Add product" |
| Update the price of 10 products | < 2 min | Products tab → Needs Price → type price, keypad "Next" ×10 → Save changes (n). Timed in the test report. |

## Audit tooling

`scripts/ux-audit/audit.mjs <baseUrl> <outDir> [authDir] [label]` screenshots
each role's key screens at 375 / 390 / 430 / 360 / 412 / 768 / 1280 / 1440 px and
records sideways overflow, inputs under 16 px, targets under 44 px, clipped text
and overlapping badges. Playwright's WebKit build does not start on the
owner's Mac (macOS 14), so the Apple sizes run in Chromium with an iPhone user
agent and touch; real iOS Safari checks need a device (see the test report).
