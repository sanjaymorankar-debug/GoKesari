# Feature 2: Add product by photo and voice (shop owners)

Owner brief, 22-Nov-2026. Branch `feat/shop-photo-listing-2026-11-22`, built on the shared base in commit
`692fdc92` (AI provider layer `runAi`, `lib/qty-words`, rule `smartShopping`, flag `shop_photo_listing_enabled`).

## What the owner does

1. **Inventory → Add product by photo** (`/shop/photo-listing`). Take 1–4 photos: front, back, label and
   barcode. The phone camera opens (`capture="environment"`); a gallery photo also works.
2. **Read photos.** AI reads them and fills the product. Each field shows how sure the AI was. Fields below
   `smartShopping.lowConfidenceBelow` (default 75) are highlighted in amber with the percentage.
3. **Price, stock and unit.** Tap 🎤 and say, for example, "साठ रुपये लिटर पन्नास बाटल्या", or type it.
   The app reads the values back on screen and aloud ("Price ₹60 per litre, stock 50 bottles"). The owner can
   correct any value in the boxes below.
4. **Catalogue check.** If GoKesari already has the product, the owner sees it and can use it, so no duplicate
   is made, or add a new product instead.
5. **Publish to my shop.** The product is live in the shop. A new product also goes to the admin review queue.
6. **Bulk mode.** "Shoot next product (review later)" keeps the draft and goes back to the camera. All waiting
   products are listed at the top, with Review and Discard buttons.

UI text is in English, Hindi and Marathi, following the board language cookie (`getBoardLang`), as on the
neighbouring shop pages.

## Routes

All shop routes return 404 while the flag is off for the shop's district. The page also returns 404.

| Method | Path | What |
|---|---|---|
| GET | `/shop/photo-listing` | The page: capture, review and the bulk list |
| GET | `/api/shops/{id}/photo-listing/drafts` | The shop's open drafts (bulk review) |
| POST | `/api/shops/{id}/photo-listing/drafts` | Multipart `photo` (1–4) plus `side` for each (FRONT, BACK, LABEL, BARCODE). AI reads them and the route returns a draft |
| GET | `/api/shops/{id}/photo-listing/drafts/{draftId}` | One draft |
| DELETE | `/api/shops/{id}/photo-listing/drafts/{draftId}` | Discard the draft. Its photos are deleted at once |
| GET | `/api/shops/{id}/photo-listing/drafts/{draftId}/photos/{photoId}` | A draft photo for the review screen. Owner only, `private` cache |
| POST | `/api/shops/{id}/photo-listing/drafts/{draftId}/publish` | Publish (body: `publishInputSchema` in the service) |
| POST | `/api/shops/{id}/photo-listing/voice` | `{ text }` → parsed price, stock and units, plus a read-back in en/hi/mr |
| GET | `/admin/photo-listing` and `/api/admin/photo-listing/report?days=30` | Admin report (permission `PRODUCT_APPROVE`). Linked from Product master → more |

**Rate limits** (`enforceRateLimit`): photo reads are limited to 20 per 15 minutes per user, voice to 60 per
10 minutes, and publish/discard use `RATE_LIMITS.MUTATION`. The AI daily limit per user
(`smartShopping.aiCallsPerUserPerDay`) is enforced by `runAi`.

**Permissions.** The shop's owner can use it, and so can support staff holding `PRODUCT_CREATE_ANY`. This is
the same rule as the existing "Create new product" route (`/api/products`). Catalogue-scope shop staff can
edit photos and descriptions, but the existing rules do not let them add products, so they cannot use this
either.

## Code

- `src/lib/price-stock-parse.ts` reads price, stock and unit without AI. It is client-safe and is used by both
  the page and the server. It is built on `lib/qty-words`, which gained one export, `numberFromWord`.
  - It reads ₹, rs and rupee words; "per", "/", "प्रति", "each"; and number phrases. Examples: "एकशे वीस" =
    120, "दीडशे" = 150, "एक सौ बीस" = 120, "one hundred and twenty" = 120, "forty five" = 45.
  - It also reads regional digits, plural and inflected unit words ("बाटल्या", "पाकिटे", "डबे", "लिटरला"),
    and a custom unit word said after "per".
  - `toListingQuantities` turns what the owner said, plus the pack, into one sellable unit, its price and the
    stock. For example, ₹60 per litre for a 500 ml bottle gives ₹30 per bottle. A dozen price for a product
    listed per piece is divided by 12.
- `src/lib/voice-input.ts` is the coordinator's shared helper, copied unchanged. It uses the Android app's
  own recogniser (app 1.13.0 and later) and otherwise the browser's Web Speech API, with mr-IN, hi-IN or
  en-IN set from the board language. Read-back uses its `speak()`. Without either recogniser the mic button is
  hidden and the owner types. **There is no server speech-to-text.**
- `src/server/services/shop-photo-listing.ts` holds the access check, the AI read, the master match,
  publishing, the retention purge and the report.
- UI: `src/components/shop-photo-listing.tsx`, `src/app/shop/photo-listing/page.tsx` and
  `src/app/admin/photo-listing/page.tsx`.
- Menu: Inventory gets the "Add product by photo" tile, with `feature: "shop_photo_listing_enabled"`. The
  tile-board test count went from 47 to 48 shop items.

### AI

- **Photos.** The photos are sent through `runAi({feature: "PRODUCT_PHOTO"})` with the zod schema
  `productPhotoSchema`. Every field is `{value, confidence}`: brand, name, variant, packSize, packUnit,
  mrpRupees, category, subCategory, barcode, FSSAI number, ingredients, vegMark, manufacturer and expiry.
- **Descriptions.** The AI also writes a description and spec lines in English **and** in the shop's local
  language. The language comes from `localBannerLanguage`: Marathi in Maharashtra and Goa, Hindi elsewhere.
- **Category.** The category guess is chosen from the active categories, with the shop's own first, and is
  resolved to a `categoryId`.
- **Photo preparation.** Before the AI reads them, photos are re-encoded with sharp: rotated upright, at most
  2000 px, JPEG, with the EXIF data dropped.
- **Unreadable photos.** If `readable: false`, the model declines, or no name, brand or barcode is read, the
  draft is saved as `UNREADABLE` with the reason (BLURRY, DARK, NOT_A_PRODUCT, CUT_OFF or OTHER) and a
  "please retake" message.
- **Voice.** The deterministic reader runs first. `runAi({feature: "VOICE_PARSE"})` is asked only when the
  price or the stock is missing, and fills only the missing parts. If AI is off or over its daily limit, that
  is not an error: the owner types the rest.
- **No AI call is ever made inside a `db.transaction`.**

### Match before create

The master catalogue (`products`) is checked in this order:

1. **Barcode/GTIN** with `findProductByBarcode` (barcode-lookup). This covers every stored GTIN form through
   the PMD helpers `analyzeGtin` and `gtinForms`, and the shop-local `barcode` column.
2. **Brand + name + pack** with product-master's `findDuplicateCandidates`. This is the §11 exact duplicate
   key: brand id, name, net quantity and variant.
3. **The PMD name comparison** (`pmd/match/score.ts` `compareNames`) over products that share the brand or the
   first word of the name. A different pack size is never a match. The name score must be at least 0.8 when
   the packs are equal, and at least 0.9 when one side's pack is unknown.

The full PMD engine (`pmd/match/engine.ts`) runs against the separate product-master database, which has
numeric ids. Shop listings point at `products`, so that table is the one matched here.

### Publish

All catalogue writes run in one transaction, using the existing services only:

- **Match accepted, not yet listed:** `addCategoryToShop`, then `createShopProduct`. The result is
  `LINKED_MASTER`.
- **Match accepted, already listed:** `updateShopProduct` sets the new price. The result is
  `UPDATED_LISTING`.
- **No match:** `createProductForShop`, the service behind the "Create new product" form and the Excel
  upload. A shop owner's product starts as `PENDING_APPROVAL` and goes into the admin review queue. Its
  similar-name check returns 409 until the owner confirms (`confirmDuplicate`), and an exact name in the same
  category is reused (`REUSED_EXISTING`).
  - On a new product, the label details are then set: kind, brand id (when the brand already exists),
    variant, net quantity, manufacturer, and the MRP with `mrpSource = SELLER_SUBMITTED`.
  - The barcode goes to the shop-local `barcode` column (not `gtin`), as the existing create flow does; our
    team may make it the GTIN on review.
- **Price:** set on both channels. A price set by someone other than the owner (without override) goes
  through `submitPriceRequests`, as in `/api/products`.
- **MRP for this shop only.** An MRP from the pack that differs from the master's goes to
  `shop_listing_details.mrp_paise`, which applies to that shop only. This is the existing bulk-upload rule.
- **Stock:** set by `updateShopProduct`, so the stock ledger (`inventory_movements`) records it.
- **Label extras:** FSSAI, ingredients, veg mark, expiry, selling unit, custom unit and local-language text go
  into `shop_listing_details.attributes.photoListing`. The product description holds the English and local
  descriptions; the specifications hold both spec lists.
- **Price above MRP:** publish is refused with 409 `PRICE_ABOVE_MRP` when the price of one pack is above the
  MRP read from the pack, or the master's MRP. The review screen warns before the owner taps Publish. The
  owner lowers the price, or corrects a misread MRP, which is then counted as a corrected field. Selling above
  MRP is refused elsewhere too (bulk upload, enforced master MRP).
- **Loose goods:** a product sold by weight or volume with no pack, no barcode and no MRP is created as
  `LOOSE` and may have an empty price (the existing rule: listed but not on sale). Packaged goods need a
  price (`PRICE_REQUIRED`).
- **Photos:** after commit, the chosen photos go through the existing pipeline,
  `shop-media.uploadListingPhoto` → `processProductPhoto`. It resizes, compresses and orients them, makes
  three WebP sizes and strips EXIF. Background removal is skipped. Each used draft copy is deleted at once.
  A photo that the pipeline refuses is reported in `photoErrors`; the product is still published.

### Units

The catalogue's `products.unit` accepts piece, pack, dozen, kg, g, L and ml.

| Said | Listed as | Notes |
|---|---|---|
| piece, nug, नग, bottle, बाटली | `piece` | |
| kg / g | `kg` / `g` | With no pack, sold loose: `LOOSE`, stock to 3 decimals |
| litre / ml | `L` / `ml` | Same as kg / g |
| dozen | `dozen` | |
| packet, पाकीट | `pack` | |
| box, डबा | `pack` | One pack = one box. The word "box" is kept in the listing's attributes |
| metre | `piece` | One piece = one metre. The catalogue has no length unit; the word is kept, and the owner sees a note |
| custom ("जुडी", "bundle") | `piece` | One piece = one of that unit. The owner's word is kept |

When the label gives a pack in a measure (for example 500 ml) and the price is per litre or per piece, the
sellable unit is the pack: `ml`, `unit_size_milli` 500 000. Its price is worked out from the per-litre price.

## Tables (migration `drizzle/0168_shop_photo_listing.sql`)

Journal entry: idx 168, when 1793266600000. Rollback: `scripts/rollback-0168.sql`. The schema is in
`src/server/db/shop-photo-listing-schema.ts`, re-exported from `schema.ts`.

- **`shop_photo_listings`**, one row per product shot.
  - Status: DRAFT, UNREADABLE, PUBLISHED or DISCARDED.
  - What the AI read: `ai_fields` (jsonb), with every field's value and confidence, the descriptions, the
    match and the category id.
  - The match: type, product and score.
  - What the owner published: `published_fields` (jsonb), `changed_fields` (text[]), `fields_kept` and
    `fields_changed`.
  - The outcome: LINKED_MASTER, UPDATED_LISTING, REUSED_EXISTING, CREATED_PENDING or CREATED_APPROVED.
  - The product and listing ids; the price, stock and units; the voice text.
  - `photos_expire_at` and `photos_deleted_at`.
  - Shops, products and listings are seller-side tables and are **not** referenced by foreign key. The service
    checks those links. `created_by` references `users`, like `ai_usage_log` in 0167.
- **`shop_photo_listing_photos`**, the photos the AI read: JPEG with no EXIF, stored as `bytea`, with a
  cascade on the listing.

**Retention.** A daily cron job, `photo-listing-purge` (`src/server/cron/schedule.ts`), deletes the photos of
rows past `smartShopping.photoRetentionDays` (default 30). Drafts left open are marked DISCARDED. The rows
stay, without photos, for the report.

## Flag

`shop_photo_listing_enabled` (feature-flags, `isFeatureEnabledForShop`). A missing row is OFF. While it is off,
the tile is hidden, the page returns 404, and every API route and service function refuses with 404
`FEATURE_NOT_AVAILABLE`. The admin report stays available. The flag needs `ANTHROPIC_API_KEY` on the server
and `smartShopping.aiProvider` = `claude`; without them, reading photos answers "not available right now".

## Tests

- `tests/unit/price-stock-parse.test.ts`: 65 cases. They cover the four brief examples, and English, Hindi and
  Marathi sentences with number words, regional digits, thousands separators, inflected and plural units and
  custom units. They also cover incomplete input, unit words, read-back in 3 languages, conversion to one
  sellable unit (bottle sizes, loose kg, dozen to piece, metre and custom) and the MRP check.
- `tests/integration/shop-photo-listing.test.ts`: 11 cases on real PostgreSQL and the real photo pipeline.
  The AI provider is **mocked**: no AI call is made.
  - Flag off: the service and the routes return 404, and AI is never called.
  - GTIN match: linked, no new product, stock in the ledger, shop-only MRP.
  - Brand + name + pack match: a different pack is not a match; the PMD name match also works.
  - New product: `PENDING_APPROVAL`, price, stock and unit set, photo through the pipeline, accuracy recorded,
    report checked.
  - Loose goods without a price.
  - MRP warning: refused, then published once the MRP was corrected.
  - Unreadable photo: retake.
  - A bad file and too many photos are refused.
  - Only the owner can use it.
  - Voice: deterministic first, AI only for the missing parts, no error when AI is down.
  - Retention purge.
- The existing tests were updated for the new tile (`tests/unit/tile-board.test.ts`, 48 shop items) and the
  new cron job (`tests/integration/cron-schedule.test.ts`).

## Not done, and why

- **Not checked on a real phone or in a browser.** The page, camera capture, the microphone and speech
  read-back were type-checked and linted only. They need a manual check on test.gokesari.com, on Android
  Chrome, iOS Safari and app 1.13.0+.
- **No real AI call was made.** The prompt and schema have only been exercised against the mock. The first
  real reads on staging should be checked for field quality and cost: `ai_usage_log`, and the report's
  "AI cost".
- **Background removal:** skipped, as the brief allows. The pipeline has none.
- **No new brand rows are created.** The brand is linked only when a brand of that name already exists
  (brands are curated by our team). Otherwise the brand is kept in the listing attributes and in the product
  name.
- **The full PMD engine is not used for matching.** It works on the separate product-master database with
  numeric ids. The shop flow matches the shop catalogue (`products`) with the PMD name scorer instead.
- **Shop staff (catalogue scope) cannot add by photo,** because the existing rules do not let staff create
  products. Changing that is an owner decision.
- **Expiry is not stored as a product field.** It belongs to a batch, so it is kept in the listing
  attributes only.
- **No offline queue.** Bulk mode needs a connection for each photo read; drafts are saved on the server, not
  on the phone.
