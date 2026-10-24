# Homepage UI/UX upgrade (October 2026)

The home page (`/`) becomes a product-discovery page. The account tiles move
into the header, a side drawer and a bottom navigation; search gets
suggestions and voice; banners, empty states, compare and the footer are
reworked; phones get a sticky header and a floating cart bar. Everything is
additive: every route, API and flow that existed keeps working.

Status, flows, test cases, regression, defects, Lighthouse and decisions:
`reports/GoKesari_Homepage_UIUX_Status_<date>.xlsx`.

## What changed

| ID | Feature | Where |
|---|---|---|
| F1 | Home = discovery only: sticky header → search → hero banners → categories → shops near you (filters) → Buy again / Popular in your area → Sell / Deliver → footer | `src/app/page.tsx`, `src/components/home/home-page.tsx` |
| F1 | Account menus: wide screens "Account" dropdown (guests: "Sign in / Create account"); phones ☰ drawer + bottom navigation (Home · Categories · Compare · Orders · Account) | `src/components/home/account-nav.tsx`, `mobile-shop-nav.tsx` |
| F1 | Hero banners: Admin / Operator → **Home banners** (`/admin/home-banners`): picture, title, button, kind, start/end, city / PIN, on/off, order. Built-in banners when none is live. Fixed height, first picture eager and the rest lazy, turns every `bannerSeconds`, pauses on hover / touch / focus / pause button, swipe and ← → | `src/components/home/hero-carousel.tsx`, `home-banner-manager.tsx`, `src/server/services/home-banners.ts` |
| F2 | Search in the header (wide: centred; phones: full width under the header, sticky). Suggestions after 2 characters (250 ms): Products · Shops · Categories, typed text highlighted, ↑ ↓ Enter Esc. On focus: recent (account, or this browser for guests) and trending. Voice search (Web Speech API, en-IN / hi-IN / mr-IN), hidden where unsupported. Submit → existing `/search?q=` | `src/components/home/search-box.tsx`, `GET /api/search/suggest`, `GET/DELETE /api/search/recent`, `src/server/services/search-suggest.ts` |
| F3 | Empty states with a picture and a next step: cart (once — the home page no longer repeats it), orders, subscriptions, wallet history, search no-results. "Popular in your area" for customers with nothing to buy again (area → city → platform → on sale nearby) | `src/components/empty-illustrations.tsx`, `src/server/services/home-discovery.ts` |
| F4 | "Compare prices" chip in the accent colour with a "Smart tool" badge ("Compare all shops" likewise); "Compare N prices" on product cards sold by 2+ nearby shops → `/search/compare?product=…`; the compare page tags "Best price" and the saving against the highest | `home-page.tsx`, `product-card.tsx`, `home-price-comparison.tsx`, `src/app/search/compare/page.tsx` |
| F5 | Footer: Company · Make Money · Support · Legal (accordions on phones), language switch and the company line | `src/components/site-footer.tsx`, `footer-columns.tsx` |
| F6 | Sticky header with "Deliver to" and the cart badge, compacting on scroll; "Deliver to" opens a bottom sheet (GPS, saved addresses, PIN); bottom navigation; floating "View cart · N items · ₹total"; safe-area insets; no sideways scroll 320–430 px; 44 px tap targets | `home-header.tsx`, `location-sheet.tsx`, `mobile-shop-nav.tsx`, `src/app/globals.css` |

All new wording is in English, Hindi and Marathi (`src/lib/home-i18n.ts`).

### Sticky headers site-wide (F6)

`html, body { overflow-x: hidden }` made `<body>` a scroll container, which
silently switched off `position: sticky` for every header on the site — the
"Deliver to" and cart scrolled away. `overflow-x: clip` keeps the same
no-sideways-scroll effect without a scroll container (browsers without `clip`
keep `hidden`).

### Finding the location by itself (24 Oct 2026)

Owner report: "user location is not detected". Before, "Deliver to" stayed on
"Set location" until the shopper opened it and tapped the GPS button. Now:

- **Found by itself** (`src/components/auto-locate.tsx`, mounted in the site
  header on every page): for a visitor or customer with no location yet — no
  choice and no saved address — on home, shops, a shop, search and category
  pages, the device's position is saved as the delivery location and the page
  refreshes. Permission already given: no prompt. Not answered yet: asked
  once per browser session. Refused: not asked again. A location chosen
  while the device was answering is kept (`ifUnset` on POST /api/location).
- **"Find your location"** button on the home page's "Set your location"
  line; when it fails, the reason (blocked, location off, too slow, not
  https, not supported) and a button to the PIN code box. The "Use my
  current location" buttons use the same code (quick network fix, then one
  GPS try) and give the same reasons instead of always "permission was not
  given".
- **Approximate address, free** (owner, 24 Oct 2026: a textual address for
  the coordinates, "I don't want paid version"): a device position is
  labelled with its approximate street address from OpenStreetMap
  (Nominatim — free, no key, no Google): "12 Lane 5, Kharadi, Pune 411014".
  One request per spot (~11 m), remembered for a day and shared with the
  Nearby screen, which shows the same address; at most one request a second
  (Nominatim's policy), "© OpenStreetMap contributors" shown with it.
  `NOMINATIM_URL` switches the server, or `off`. No PIN code is saved from it
  (approximate; discovery goes by distance). When OpenStreetMap has nothing or
  is busy: the area and city of the nearest shop or saved address within
  2 km ("Kharadi, Pune"); "Current location" only when nothing is known at
  all. Headings keep the area ("Shops near Kharadi").
- **Nearby screen**: the position it finds also becomes the delivery
  location when none is chosen.

Saved in the `gk_location` cookie on the device (30 days), as before — never
in the database. In the app the phone's own location permission decides.
Code: `src/lib/device-location.ts`; tests: `tests/unit/device-location.test.ts`,
`tests/integration/device-location.test.ts`; results:
`LOCATION_DETECT_TEST_RESULTS_2026-10-24.md`.

## Switching it off

Rule **`homeDiscovery`** (Admin → Settings → Rules), on by default:
`{ "enabled": true, "bannerSeconds": 6 }`. Off brings back the Tile Board
home and hides the bottom navigation and floating cart bar; nothing else
changes and no data is touched.

## Database (both layouts)

| Migration | Split tag | What |
|---|---|---|
| `0086_home_banners_search` | `core` | `home_banners`, `search_queries` (platform tables, next to `users`) |
| `0087_search_trigram_indexes` | `seller` | GIN trigram indexes on `products.name`, `shops.name` (pg_trgm, already installed by 0015) |

Both are additive. Rollback: `scripts/rollback-0086.sql`,
`scripts/rollback-0087.sql`. The code tolerates the tables' absence (no
banners → built-in banners; search history not kept), so the code may be
deployed before the migration runs on production.

New permission **`HOME_BANNER_MANAGE`** (admin + operator). New rate limit
`SEARCH_SUGGEST` (120 a minute per visitor).

## Mobile app 1.3.0

The app shows the website, so F1–F6 reach it on deploy. 1.3.0 adds what the
native side needs: iPhone microphone and speech-recognition descriptions (the
website shows the mic in the app only from 1.3.0 — iOS closes an app that
reaches for the microphone without them), `/search/compare` links open in the
app, and a white strip under the bottom navigation.

## Tests

- Unit: `tests/unit/homepage-uiux.test.ts`; integration (real PostgreSQL):
  `tests/integration/homepage-uiux.test.ts`; app: `mobile/src/__tests__/homepage-uiux.test.ts`.
- Playwright, any site (production-safe as a guest; the signed-in group runs
  on a local server only):

  ```bash
  E2E_BASE_URL=https://test.gokesari.com CHROMIUM_PATH=/opt/pw-browsers/chromium \
    npx playwright test tests/e2e/homepage-uiux.spec.ts --project=chromium
  ```
