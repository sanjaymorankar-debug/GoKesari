# Brand search, barcode search and favourites (Module 3, 23-Nov-2026)

Owner brief 23-Nov-2026, Module 3. Everything below is behind one feature flag,
**`brand_barcode_favourites_enabled`**, seeded **OFF** by migration 0187. While it is off the site behaves exactly
as before: no brand group, no scan button, no hearts, no Favourites tile; `/brand/…`, `/favourites` and the new
APIs answer 404.

## What existed before

| Area | Existed | Gap |
|---|---|---|
| Brands | `brands` table (with slug), `products.brand_id`, admin service `services/brands.ts` | Search did not match brand names; no brand filter; no brand group in suggestions; no brand page |
| Barcode | `components/barcode-scanner.tsx` (BarcodeDetector + ZXing + typed number), `pmd/normalize/identifiers.ts` GS1 check digit, shop-only `services/barcode-lookup.ts` | No customer lookup; the shop lookup's `cleanBarcode` takes any 6+ characters and never says a check digit is wrong |
| Favourites | Nothing (`lib/board/menus.ts` said so; "wishlist" is the smart-list feature, not reused) | Everything |

## What was built

**Brand search**
- `services/catalogue.ts` storefront filters gain `matchBrands` (a typed word may match the active brand's name),
  `brandId` and `productIds`. The search page passes `matchBrands` only with the flag on.
- `services/brands.ts`: `getPublicBrandBySlug`, `searchPublicBrands` (active brands with at least one approved product).
- Suggestions (`/api/search/suggest`) get a `brands` group (only with the flag on; the key is absent when off).
- `/search?q=…&brand=<slug>` filters to one brand; brand chips under the header; with the brand chosen and the query
  being the brand's own name, every product of the brand is listed.
- `/brand/[slug]`: the brand's products, from shops that deliver to the customer (`?all=1` for every shop), with hearts.

**Barcode search**
- `lib/retail-barcode.ts`: accepts EAN-8, UPC-A, EAN-13 and GTIN-14 with a valid GS1 check digit; otherwise a plain
  reason (`EMPTY`, `NOT_DIGITS`, `WRONG_LENGTH`, `CHECK_DIGIT` with the expected digit).
- `services/product-barcode-search.ts` + `GET /api/products/barcode?code=` (public, rate limit 30/min per user or IP):
  approved active products whose `gtin` (any stored form) or `barcode` equals the code — several when the code is
  shared (at most 10) — with name, brand, pack size, MRP, shops listing it, and the lowest price / shop count near
  the customer's chosen location.
- Search box: a scan button (camera, or type the number) opening a sheet with the results, each linking to the product
  page. The sheet is rendered in a portal so its form never submits the search form.
- Shop flow unchanged; `findProductByBarcode` now also returns `invalidCheckDigit: true` when a GTIN-shaped code has
  a wrong check digit (extra field only; the lookup runs as before).

**Favourites**
- Table `favourites` (user_id → users, cascade; product_id, no FK — catalogue side, checked in the service;
  primary key on the pair). Max 500 per account.
- `services/favourites.ts`: add / remove / list ids / merge a guest's ids / describe with the lowest price
  (`catalogue.lowestOffersForProducts`, two queries for any number of products; cheapest buyable listing first).
- `GET /api/favourites` (ids, or `?details=1`), `POST { productId }` or `{ productIds }` (guest merge),
  `DELETE ?productId=` — signed in, rate-limited. `GET /api/favourites/details?ids=` — public, prices a guest's
  browser list (stores nothing).
- Heart on `ProductCard` (pages pass `favourites` to `ProductGrid`: search, category, shop, brand) and on the product
  page header. Guests' hearts are kept in localStorage (`gk_favourites`, max 100) and merged into the account on the
  first signed-in page with a heart (or `/favourites`), then cleared from the browser.
- `/favourites`: each product with lowest price (near you when a location is set), shop, "Add to cart" (that shop's
  listing) and Remove; removed products show as "No longer sold".
- Board: Orders → Favourites tile (`feature: brand_barcode_favourites_enabled`), on the customer board and account menu.
- Not audit-logged (personal data like the cart, which is not audited either).

Hindi/Marathi: all new customer strings are in `src/lib/brand-barcode-favourites-i18n.ts` (`L()` + `tr()`).
The brand page's location line reuses the search page's English wording, as that page does.

## Migration

`drizzle/0187_brand_barcode_favourites.sql` — `favourites` table + indexes, trigram index on `brands.name`, flag row
OFF. Additive, re-runnable. Rollback: `scripts/rollback-0187.sql` (drops the table — export it first if customers'
favourites should be kept).

## Files

New: `src/lib/retail-barcode.ts`, `src/lib/favourites-client.ts`, `src/lib/brand-barcode-favourites-i18n.ts`,
`src/server/services/{favourites,favourites-flag,product-barcode-search}.ts`,
`src/app/api/favourites/route.ts`, `src/app/api/favourites/details/route.ts`, `src/app/api/products/barcode/route.ts`,
`src/app/brand/[slug]/page.tsx`, `src/app/favourites/page.tsx`, `src/components/favourites/{favourite-heart,favourites-list}.tsx`,
`src/components/search/barcode-search.tsx`, tests below.
Changed: `schema.ts`, `feature-flags.ts`, `feature-flags-panel.tsx`, `catalogue.ts`, `brands.ts`, `search-suggest.ts`,
`barcode-lookup.ts`, `rate-limit.ts`, `api/search/suggest/route.ts`, search / category / shop / product / home pages,
`layout.tsx`, `site-header.tsx`, `home-header.tsx`, `home-page.tsx`, `search-box.tsx`, `product-card.tsx`,
`product-grid.tsx`, `customer-board.tsx`, `menus.ts`, `icons.tsx` (heart, scan-barcode).

## Tests

- `tests/unit/retail-barcode.test.ts` — formats, check digit, reasons, lookup forms.
- `tests/integration/brand-barcode-favourites.test.ts` — brand matching / filter / inactive brand, suggestions with and
  without the flag, barcode lookup (forms, nearby price, shared codes, unapproved hidden, route 404/422/429), shop
  lookup unchanged + warning, favourites service (idempotent add, unknown product, limit, merge, pricing near / far,
  removed product) and routes (404 flag off, 401, add / merge / remove, other customers untouched).

## Still open / not verified

- Not checked in a browser (camera scan, hearts, guest merge) — needs a run on staging with the flag on.
- UPC-E (8-digit compressed UPC) is not expanded: such a code fails the EAN-8 check digit and gets the "not valid"
  message. Rare on Indian packs.
- Few catalogue products have `brand_id` / `gtin` filled yet; brand search and barcode search are only as good as
  that data (catalogue team).
- Owner decision: switch the flag on (staging first).
