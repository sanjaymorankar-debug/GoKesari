# Test results — Tile Board home screens (9 Oct 2026)

> On the owner's Mac this file belongs in
> `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking`.

Feature: approved design "Theme 1 Tile Board" for customer (`/`), shop owner
(`/shop`), admin and operator (`/admin`). See `README.md` in this folder.

## 1. Summary

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** |
| `npx eslint src tests --ext .ts,.tsx` | **Pass** — 0 errors; 4 warnings, all pre-existing on `staging` (none in new files) |
| `npm test` (Vitest, real PostgreSQL 16) | **Pass** — 125 files, 1,610 tests (29 new in `tests/unit/tile-board.test.ts`) |
| `npm run build` | **Pass** |
| Board fits the first screen, no horizontal scroll — 4 roles × 2 sizes × 3 languages (local) | **Pass**, 24/24 (plus signed-out, new customer, empty shop and pending shop: 24/24) |
| Every tile and chip opens a real page, HTTP 200, no redirect home (local) | **Pass** — customer 28/28, shop owner 32/32, admin 37/37, operator 21/21, signed-out 14/14 links |
| Language switch (click, cookie, server render, survives reload) | **Pass** |
| Other pages keep the site header and layout | **Pass** |
| test.gokesari.com | see §5 |

## 2. Unit tests added (`tests/unit/tile-board.test.ts`, 29 tests)

- **Language parsing:** en/hi/mr; case, spaces and region tags (`hi-IN`,
  `mr_IN`); anything else (missing, empty, `fr`, tampered, non-string) → English.
- **Count formatting:** 1, 128, 9.6k, 17.9k, 18k, 99.9k (never rounds up to
  "100k"), 1.2L, 3.4Cr; no badge for undefined / null / NaN / negative /
  infinite; zero hidden unless asked; rupees from paise.
- **Link placeholders:** filled and URL-encoded; fallback when missing or
  empty; hidden when there is no fallback.
- **Permission filtering:** admin sees all 39 + 3 "Do now"; an operator never
  sees admin-only entries; a customer sees no staff tiles; finance /
  marketing / analytics only for shop owners; any-of permission lists; **no
  link an operator can see points at a page that sends operators home**
  (this test caught a real bug during the build: the Payments tile's own link
  went to `/admin/finance` for operators — fixed).
- **Definitions:** menu counts match the mockups (6 / 8 categories / 16 / 9 / 6
  menus; 18 / 39 / 39 / 22 submenus); every label present in all three
  languages; only known icons and count keys; unique keys.
- **Routes:** every link in the menu definitions (placeholders and fallbacks
  included) matches a `page.tsx` under `src/app`; every `#anchor` exists as an
  `id` in the source; the checker itself rejects a made-up route.

## 3. Local browser checks (Playwright, Chromium)

**Set-up:** PostgreSQL 16, `npm run db:migrate`, `npm run db:seed`, `next dev`
(the development sign-in form). Accounts: `customer@test.local` (customer),
`kesari.dairy@example.com` (seeded shop owner), `admin@test.local` and
`operator@test.local` (role set in the database), plus `empty.customer@test.local`
(new customer), `green.dairy@example.com` (shop with no orders) and
`pending.shop@example.com` (shop awaiting approval).

**With data** (customer): ₹5,000 wallet top-up, Cow Milk subscription
starting tomorrow, one order in progress (CONFIRMED), one delivered order, one
item in the cart. Board showed: order banner with Track, tomorrow's banner
with Change, wallet ₹4,860, Active 1 (red), Past 1, Subscriptions 1, cart bar
"Cart · 1 item · ₹100 · From Kesari Dairy Farm", Buy again "Cow Milk ₹70 / L"
(Add → cart API, item added).

**Empty data:** new customer, shop with no orders and a pending shop all show
the full board with no badges and no banners; nothing breaks.

### 3.1 Fit (measured: lowest visible board element vs. window height; page width vs. window width)

| Role | Size | EN | HI | MR | Horizontal scroll |
|---|---|---|---|---|---|
| Customer (with data, both banners) | 360×800 | 800 / 800 | 800 / 800 | 800 / 800 | none |
| Customer | 1366×768 | 752 / 768 | 752 / 768 | 752 / 768 | none |
| Shop owner | 360×800 | 743 / 800 | 698 / 800 | 703 / 800 | none |
| Shop owner | 1366×768 | 752 / 768 | 752 / 768 | 752 / 768 | none |
| Admin | 360×800 | 792 / 800 | 792 / 800 | 792 / 800 | none |
| Admin | 1366×768 | 752 / 768 | 752 / 768 | 752 / 768 | none |
| Operator | 360×800 | 792 / 800 | 792 / 800 | 792 / 800 | none |
| Operator | 1366×768 | 752 / 768 | 752 / 768 | 752 / 768 | none |
| Signed-out visitor (production build) | both | pass | pass | pass | none |

(The customer's cart bar is pinned to the bottom edge of the first screen, so
it measures exactly 800 on a phone.)

### 3.2 Links (each opened in the browser, signed in as the role)

| Role | Links | 200, real page, no redirect home | Notes |
|---|---|---|---|
| Customer | 28 | 28 | `/orders#order-…` scrolls to the order card |
| Shop owner | 32 | 32 | `/shop/finance#invoices`: the Invoices section exists only once the shop has invoices; until then the link opens the top of the finance page |
| Admin | 37 | 37 | |
| Operator | 21 | 21 | `/admin/returns` timed out once while the dev server was still compiling; 200 when re-opened |
| Signed-out | 14 | 14 | account-only tiles go to `/signin` |

### 3.3 Interaction

| Check | Result |
|---|---|
| Tap मरा → board re-renders in Marathi (`lang="mr-IN"`), cookie `gk_lang=mr`, still Marathi after reload; EN switches back | Pass (phone and desktop, dev and production build) |
| Deliver-to opens the location chooser | Pass |
| Account menu: name, profile links, sign out (role switcher shows for users with several roles) | Pass |
| Bell → `/profile#notifications`, unread count from the database | Pass |
| Keyboard focus ring visible (2px solid) | Pass |
| Reduced motion: existing global rule applies (no new animation added) | Pass |
| Site header hidden only while a board is on the page; `/shops`, `/orders`, `/wallet`, `/profile`, `/admin/orders`, `/admin/dashboard`, `/shop` without a shop all unchanged | Pass |

### 3.4 Screenshots

`screenshots/local-*.png` — customer (EN phone, MR phone, EN desktop), shop
owner (EN phone, HI phone, EN desktop), admin (EN phone, MR phone, EN
desktop), operator (EN phone, EN desktop).

## 4. Compared with the mockups

Layout, colours, menu names and grouping follow the five mockups. The
differences, and why, are listed in `README.md` ("Differences from the
mockups", "Substitutions", "Chips that share a destination").

## 5. test.gokesari.com

_Filled in after the deploy (see below)._
