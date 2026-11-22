# Smart shopping — photo shopping list, add product by photo, WhatsApp orders

*Owner brief 22-Nov-2026 18.23 IST. GoKesari (gokesari.com, test.gokesari.com).*

Three features on one shared base:

| # | Feature | Who | Flag (Admin → Feature flags) | Detail |
|---|---|---|---|---|
| 1 | Photo shopping list → wishlist → shop price comparison | Customer | `smart_list_scan_enabled` | this file |
| 2 | Photo + voice → product listing | Shop owner | `shop_photo_listing_enabled` | [FEATURE2_PRODUCT_BY_PHOTO.md](FEATURE2_PRODUCT_BY_PHOTO.md) |
| 3 | New orders on the shop owner's WhatsApp | Shop owner | `whatsapp_shop_orders_enabled` | [FEATURE3_WHATSAPP_ORDERS.md](FEATURE3_WHATSAPP_ORDERS.md) |

All three flags are off until an admin switches them on (a missing row is OFF).

**Correction to the brief.** The brief says seller and customer data are in separate databases. That
stopped being true in Nov 2026: both sites have one database (CLAUDE.md). Seller and customer tables still
have no foreign keys between them, and these features keep to that rule.

## Shared base

| Piece | File |
|---|---|
| AI provider layer — one door for every AI call; provider and model are admin config; per-user daily limit; cost log | `src/server/ai/provider.ts`, `src/server/ai/providers/claude.ts` |
| AI usage log (tokens, estimated cost, latency, outcome — never the photo or text) | table `ai_usage_log` (0167) |
| Quantities and units as written or spoken in India (regional digits, Marathi/Hindi number words, अर्धा / पाव / दीड / डझन / नग / पाकीट …) and pack maths | `src/lib/qty-words.ts` (tests `tests/unit/qty-words.test.ts`) |
| Voice input for pages: the app's recogniser (app 1.13.0+) or the browser's Web Speech API; read-back | `src/lib/voice-input.ts`, `mobile/src/speech.ts` |
| Admin settings | Rule `smartShopping`: AI provider (`claude` / `off`), model, comparison radius (3 km), max shops compared (15), photo retention (30 days), AI calls per user per day (40), low-confidence threshold (75), pages per scan, photos per product, upload size. Rule `whatsappShopOrders`: template names, language, staff numbers (3), fallback |
| Dashboard | `/admin/smart-shopping` (admin and operator Reports): scans per day, AI match accuracy, AI calls, response time, cost |

**Keys (environment only, never in code):**
- `ANTHROPIC_API_KEY` — AI vision. It is already used for bill reading.
- `SMART_SHOPPING_AI_MODEL` — optional; default `claude-opus-5-5`. The admin rule overrides it.
- Meta WhatsApp keys — see Feature 3.

There is no server speech-to-text key. Speech is recognised on the phone or in the browser.

## Feature 1 — customer: photo shopping list

**Entry points:** the "Scan my shopping list" tile on the customer home (both the Tile Board and the
discovery home) and in the cart. Other pages: `/wishlist/scan`, `/wishlist` (saved lists),
`/wishlist/<id>` (review and edit), `/wishlist/<id>/compare`.

1. **Capture.** Camera or gallery, several pages, rotate / remove / retake each page. The browser fixes
   the orientation, auto-crops to the written area, scales to at most 2000 px and compresses to JPEG
   (`src/lib/smart-list-image.ts`). The server re-encodes privately as webp (`sharp`).
2. **Read.**
   - The AI reads handwritten or printed lists in mr, hi, en, gu, kn, ta, te, bn, ur, or a mix. Several
     photos are pages of one list.
   - For each line it returns: the raw text, the language, the English name, the name in the app
     language, the brand, the quantity and unit, and a read confidence.
   - A bill gives product names only. Amounts are never read as quantities.
   - Quantities are normalised by `qty-words` first; the AI's number is the fallback.
   - Each item is matched to the master catalogue (`src/server/services/smart-list/match.ts`):
     - pg_trgm fuzzy match on `products.name`;
     - local names and synonyms in `product_local_names.search_text` (साखर = Sugar, तूप = Ghee);
     - a brand bonus.
     The confidence is the lower of the read confidence and the match score.
   - An unreadable photo (BLURRY, DARK, NOT_A_LIST, EMPTY) is shown with a reason and a Retake button.
     The customer never gets an empty wishlist silently.
3. **Review.** One editable row per item:
   - written text | English | your language | matched product | qty | unit;
   - rows below the threshold, and items with no match, are highlighted;
   - the product can be changed (AI alternatives or a search), and items can be removed or added.
   "Save wishlist" stores the list on the account with its scan reference.
4. **Compare** (`src/server/services/smart-list/compare.ts`).
   - **Shops:** the existing Nearby logic (`listNearbyShops`), within the radius, open for orders,
     nearest first.
   - **Per shop, a virtual cart:**
     - the exact catalogue product, or else the cheapest *similar* listing (labelled);
     - pack conversion: 2 kg from 1 kg packs = 2 packs; 1.25 kg from 500 g packs = 3 packs, with the
       difference shown;
     - loose goods take the exact amount;
     - an item is available only with enough stock;
     - a loose item with an empty price shows "Price on confirmation" and is left out of the total.
   - **Prices** are the shop's online price after live offers, the same as the cart charges.
   - **Delivery options:** pickup (free), the shop's own delivery, or a GoKesari partner — with the shop's
     delivery fee and an estimated time (preparation + 4 min/km).
   - **Sorting:** lowest total, nearest, or most items. A shop opens its per-item breakdown, and a grid
     shows items × shops.
5. **Order.** "Which shop do you want to order from?" re-prices the list at that shop now and reports any
   change since the comparison. The available items go into the **normal cart**, so checkout, payment and
   fulfilment are unchanged; the cart page re-validates before payment as always. Items not ordered stay in
   the wishlist as "not ordered", and "Order the N not-ordered items from another shop" compares just those.
6. **Privacy.** Photos are private: only their customer (and admins) can see them, through
   `/api/smart-list/scans/<id>/pages/<n>`. They are deleted after `photoRetentionDays` by the daily cron job
   `smart-list-photo-retention`. The scan row stays, without photos, for the accuracy figures.

### API

| Method & path | Does |
|---|---|
| `POST /api/smart-list/scans` | multipart `page` (repeat), `lang` → `{ scanId, status, unreadableReason, languages, isBill, lines[] }` |
| `GET /api/smart-list/scans/:id/pages/:n` | the page photo (owner or admin; 404 after deletion) |
| `GET /api/smart-list/products?q=` | product picker |
| `GET/POST /api/smart-list/wishlists` | list / save `{ name?, scanId?, items[] }` |
| `GET/PATCH/DELETE /api/smart-list/wishlists/:id` | read / edit (name, all items) / delete |
| `GET /api/smart-list/wishlists/:id/compare[?pending=1]` | the comparison (needs a location) |
| `POST /api/smart-list/wishlists/:id/order` | `{ shopId, seen? }` → `{ added, notAdded, changes }` |
| `POST /api/smart-list/wishlists/:id/reset` | every item back to "to buy" |

All routes need a signed-in customer, are refused (404) while the flag is off, and are rate-limited.

### Tables (0167, rollback `scripts/rollback-0167.sql`)

- `ai_usage_log`
- `shopping_list_scans` + `shopping_list_scan_pages` (private photos, DB or MEDIA_DIR)
- `smart_wishlists` + `smart_wishlist_items`: master `product_id`, `ai_product_id` (for accuracy),
  quantity in base units, status PENDING / IN_CART / ORDERED / NOT_ORDERED

**Why not `purchase_lists`.** Its items point at one shop's listing (`shop_product_id`), so they cannot be
compared across shops. The wishlist needs master products, the written text and the AI's original
suggestion. "My lists" is unchanged.

### Tests

- `tests/unit/qty-words.test.ts` (10)
- `tests/integration/smart-list.test.ts` (9). The AI is mocked; the catalogue, packs, stock, prices and
  cart are real.
- `tests/integration/cron-schedule.test.ts`, updated for the new job.
- OCR accuracy and response time:
  - `scripts/qa/smart-list-ocr-set.ts` builds 20 **synthetic** list images (printed fonts; blurry, dark,
    rotated, bill and unreadable samples) in `tests/fixtures/smart-list-ocr/`;
  - `scripts/qa/smart-list-ocr-benchmark.ts` runs them, plus any real photos added to `expected.json`,
    against test.gokesari.com.
  - Real handwritten Marathi photos come from the owner. Synthetic images are labelled as such in every
    report.

## Mobile apps (1.13.0)

- Every screen is a website page, so all three features appear in the installed apps as soon as the
  website is deployed. Camera, gallery and location already worked.
- **New native code:** speech to text for pages (`expo-speech-recognition` 57.1.1, bridge message
  `speech.listen`). Android's WebView has no Web Speech API, so without it voice input would not work in the
  Android app.
- **Permissions:** Android asks for the microphone (RECORD_AUDIO) only while a mic button is tapped. The
  iPhone microphone and speech texts are updated.
- `/wishlist` is added to App Links.
- Version 1.13.0: Android versionCode 14, iPhone build 14.
