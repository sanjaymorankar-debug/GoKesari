# Puja Samagri & Temple Supplies (पूजा सामग्री) — new shop type

Owner brief: 20-Nov-2026, 10.20 IST. Built 20-Nov-2026 (IST). Branch `feat/puja-samagri-2026-11`.

A new shop type for everything a home puja or a temple needs, with a seeded master
catalogue of **499 SKUs** (15 categories, 80 product types), and the shop-owner, admin /
operator and customer features the brief asks for. Additive only: new tables, new
nullable / defaulted columns, one extra OR-branch in `shop_sells_food()`; no existing flow,
shop type or row is changed.

## Where things are

| Piece | Path |
|---|---|
| Catalogue data (names en/hi/mr, synonyms, variants, units, MRP, flags, HSN/GST, festivals) | `src/server/puja/catalogue-data.ts` |
| Catalogue expander (one row per SKU) | `src/server/puja/catalogue.ts` |
| Shared constants (type key, categories, festivals, units, IST helpers) | `src/lib/puja.ts` |
| Schema migration (additive, reversible) | `drizzle/0153_puja_samagri_schema.sql`, rollback `scripts/rollback-0153.sql` |
| Seed migration (idempotent, generated) | `drizzle/0154_puja_samagri_catalogue.sql` |
| Generator (seed SQL, CSV, Excel, placeholder images) | `scripts/puja/build-catalogue.ts` |
| Re-run the seed / prove idempotency | `scripts/puja/seed-catalogue.ts` (`DATABASE_URL=… node --import tsx scripts/puja/seed-catalogue.ts`) |
| Catalogue file | `docs/puja-samagri-2026-11/puja-samagri-catalogue.csv` and `.xlsx` |
| Placeholder image per category | `public/images/puja/<category-slug>.svg` |
| Shop owner service | `src/server/puja/service.ts` |
| Admin / operator service | `src/server/puja/admin.ts` |
| Customer storefront + price requests | `src/server/puja/storefront.ts` |
| Screens | customer `/puja`, owner `/shop/puja`, admin & operator `/admin/puja`, Nearby `/shops/nearby?type=PUJA_SAMAGRI` |
| Tests | `tests/unit/puja-catalogue.test.ts`, `tests/integration/puja-samagri.test.ts` |

## Data model (migration 0153)

- `product_local_names` — Hindi / Marathi names and synonyms of any master product, plus a
  lower-cased `search_text` (trigram index). Site search (`listStorefrontProducts`), the
  header suggestions and the puja screens match it, so "कपूर", "camphor", "kapoor" and
  "मेणबत्ती" all find the right items.
- `product_catalogue_attrs` — perishable / edible flags, festivals, variant attributes, the
  selling unit as the brief states it (pcs, pack, box, dozen, g, kg, ml, L), the
  **"HSN/GST to verify with CA"** flag, and `merged_into_product_id`.
- `product_subcategories` (product types) gains Hindi / Marathi names, `owner_shop_id`,
  `approval_status` (APPROVED / PENDING_APPROVAL / REJECTED / MERGED), unit, variant
  attributes, loose / perishable / edible flags, review fields. Existing rows: APPROVED, no
  owner — unchanged.
- `shop_added_types` — a shop of another type that also carries the puja range ("added shop
  type"). `shops.shop_type` stays as it is.
- `listing_price_requests` — "price on confirmation" requests.
- `festival_collections` — festival banner + kit promotion by date range (IST on screen).
- `shop_sells_food()` — gains: a shop that lists an edible catalogue line needs FSSAI while
  the admin toggle `pujaSamagri.edibleNeedsFssai` is on (default on). The first three
  branches are unchanged; every other shop type gives the same answer as before.

Seed (0154): the shop type as an admin-managed `shop_types` row (so Admin → Shop types /
Puja Samagri → Configuration can switch it on and off), 15 product categories
(department `PUJA_SAMAGRI`), 80 product types, 499 products, their local names and flags.
Every insert skips what exists (by key / slug / product), so re-running adds nothing and
never overwrites later edits.

## Brief → what was built

| Brief | Built |
|---|---|
| §3 rule: picking the type / adding a category seeds inventory at 100; owner sets missing price | `seedPujaCatalogue`: every product of the ticked categories, stock 100 (rule `pujaSamagri.seedDefaultStock`), priced at MRP; loose / no-MRP items with an empty price and sale off until the owner prices them. Registration wizard step "Add your products" shows this for a Puja shop (instead of the 100-item starter shelf). |
| §3 shop-only MRP | existing `shop_listing_details.mrp_paise` (Stock, price & MRP screen); tested: master and other shops unchanged. |
| §3 loose goods show an empty price | seed + customer "Price on confirmation". |
| §3 duplicate check, close matches first | own types and own products: exact match refused, close matches (Levenshtein ≤ 25 %, contains, same Hindi / Marathi name) returned closest first; owner confirms to go ahead. |
| §5a type at registration and as an added type; deselect first | `shop_types` row → registration picker; `/shop/puja` "Take catalogue" with category and product untick; added type recorded. |
| §5b browse, filter, multi-select add | `/shop/puja` "Browse & add" (category, type, festival, loose / packed, search en/hi/mr/synonyms, not-in-my-shop). |
| §5c manage inventory | existing screens (linked): stock, price, shop MRP, % off MRP, photos, descriptions, pause, low-stock threshold. |
| §5d remove / restore | existing soft delete + new "Removed" tab with Restore (price, stock, history kept). |
| §5e bulk Excel / CSV + inline grid | existing bulk upload and stock grid (linked). |
| §5f–h own product type / product, promotion to master | "New type / product" tab; review queue; approval puts it in the master for every puja shop; the creating shop's own data is never changed. |
| §6 manage master: add, edit, retire, merge, bulk import / export, HSN/GST with "to verify", synonyms | `/admin/puja` Catalogue tab. |
| §6 review queue approve / reject / merge with reason, real-time notice | `/admin/puja` Review tab; owner gets an in-app notification + push at once. Operators and admins. |
| §6 configuration: fee, documents, FSSAI toggle, enable / disable | `/admin/puja` Configuration; standard shop fee; GST / PAN as today; FSSAI toggle for edible lines; on / off. |
| §6 festival collections by IST date range | `/admin/puja` Festivals; optional home-page banner for the same dates. |
| §7 tile on home and in Nearby | "Puja Samagri" category tile (home and board, 3×3 on phones, 9 across on desktop); Nearby "🪔 Puja Samagri" chip with real distance and directions. |
| §7 search en/hi/mr + synonyms; filters | `/puja` and site search. |
| §7 kits and festival collections first in festival windows | storefront order. |
| §7 price on confirmation | customer "Ask price" → shop answers → listing priced → customer notified → normal cart. |
| §7 order, payment, cancellation, fulfilment, OTP unchanged | not touched; puja listings use them as they are (integration test: cart → checkout → cancel → refund). |
| §8 mobile apps | the apps are the website in a WebView, so every screen is in the apps; 1.9.0 (Android versionCode 10, iOS build 10) adds `/puja` to app links. |

## Decisions taken (flag to the owner)

1. **One database.** The brief mentions separate seller and customer databases; that split
   was removed in Nov 2026 (CLAUDE.md), so everything is in the one database.
2. **"Added shop type" without changing a shop's main type.** A shop has one `shop_type`;
   taking the puja catalogue records Puja Samagri in `shop_added_types` (used by Nearby and
   the admin counts) and leaves the main type alone.
3. **Price on confirmation without changing orders or payments.** Orders are prepaid, so a
   line without a price cannot be checked out without changing the payment flow the brief
   says must stay unchanged. Instead the customer asks the price; the shop's answer becomes
   the listing's price and the customer is told; then the normal cart applies.
4. **Ghee and til items are edible.** Besides category 10 and the edible kits / bulk lines,
   puja ghee, havan ghee and the Sankranti til sweets are flagged edible (they are food under
   FSSAI). A shop that does not want FSSAI can untick them.
5. **MRPs are typical retail estimates**, blank for branded packs, loose goods and items
   whose price varies; every HSN / GST value is marked "to verify with CA" until an admin
   ticks it verified.
6. **Customer category tiles: 9.** The grid becomes 3 × 3 on phones and 9 across on desktop
   to keep the board on one screen.
7. **Review queue for operators too** (brief §6); the older product-approval queue stays
   admin-only.
