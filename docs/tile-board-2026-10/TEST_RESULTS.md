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
| test.gokesari.com (PR #112 merged to `staging` as 6d60dbc; board served ~2 min later) | **Live.** Signed-out board verified on the site; signed-in roles verified locally only — see §5 |

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

**Deployed:** PR #112 merged into `staging` (merge commit 6d60dbc, CI green on
the PR). test.gokesari.com served the new board about 2 minutes later.

**Signed in as:** nobody. Signing in on the test site needs the emailed
sign-in code from the owner's mailbox; reading it was not permitted in this
session, so **customer, shop owner, admin and operator were verified locally
only** (§3). On the test site the signed-out board — which is the customer
board, with account-only tiles leading to sign-in — was verified:

| Check (test.gokesari.com, Chromium) | Result |
|---|---|
| Fit, 360×800 and 1366×768 × EN/HI/MR (6 runs) | **Pass** — 800/800 and 752/768, no horizontal scroll, site header hidden on `/` |
| Every tile/chip link (14) | **Pass** — all 200, no redirect home; account-only entries open `/signin` |
| Language switch (phone and desktop): click मरा → Marathi, cookie set, survives reload, EN back | **Pass** |
| Deliver-to opens the location chooser; cart bar on the first screen | **Pass** |
| Live figures: shop count 9 and "All 45" categories come from the test database | **Pass** |
| `/shop` and `/admin` signed out → sign-in page, site header shown; `/search`, `/categories` unchanged | **Pass** |

Hostinger's CDN answers the very first request from a fresh headless browser
with a 403 bot check (`server: hcdn`); the retry is 200. This is the hosting
layer, not the app.

### 5.1 Mobile app ("GoKesari Test" preview build)

The app shows test.gokesari.com in a WebView, padding the status bar and the
bottom system area itself. Emulated as the app does (Android Chrome WebView
user agent with the `GoKesariApp` token, touch, 360×728 = a 360×800 phone
minus the bars, and 412×843):

| Check | Result |
|---|---|
| Board fits, no horizontal scroll, header 57 px, EN and MR | **Pass** |
| Tapping a chip (Open now) opens `/shops?open=1` | **Pass** |
| Language switch and cart bar | **Pass** (same page as §5) |

At 728 px the signed-in boards with data ran 2–41 px past the screen
(customer with both banners, shop owner with badges, admin). Follow-up PR:
on phone-width screens shorter than 760 px the chips and category tiles get
slightly smaller. Measured locally at 360×728 after it: customer tiles end at
702 (cart bar at 728), shop owner 717, admin 720, operator 720 — all fit;
360×800 and 1366×768 unchanged (re-measured, same figures as §3.1).

**No new app build is needed** — the app loads the website, so it shows the
board as soon as the site does.

**Known limit:** a desktop browser whose usable height is well under 768 px
(e.g. 1366×657 with toolbars) needs a short scroll on the customer (≈80 px)
and admin (≈27 px) boards; the 1366×768 target fits.

Screenshots: `screenshots/test-site-*.png`.
