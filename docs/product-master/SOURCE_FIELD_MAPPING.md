# Source → field mapping

How each working source's fields become platform fields, and where those land in the schema. Two hops: **source field → staged field** (per adapter, below) and **staged field → database** (the same for every source).

Fields marked **not stored** are dropped on purpose — personal data or data the platform must not keep.

## Hop 2 — staged field → database (all sources)

| Staged field | Normalised as | Lands in |
|---|---|---|
| `sourceProductId`, `sourceUrl`, `availability`, `rating`, `reviewCount`, `sourceConfidence` | as given | `product_source` (`source_product_id`, `source_url`, `source_availability`, `source_rating`, `source_review_count`, `data_confidence`) |
| `name` | text cleaned; core name = name minus brand and pack tokens | `product_master.product_name` (best source wins), `normalized_name`, `search_text`; `product_source.source_product_name` (this source's own) |
| `brand` | NFKC/case/punctuation/company-suffix folded to a brand key; spelling kept as alias | `brand`, `brand_alias`, `product_master.brand_id`; `product_source.source_brand` |
| `manufacturer` | same, as a company | `manufacturer`, `manufacturer_alias`, `product_master.manufacturer_id` |
| `categories[]` | source category → standard category through `category_mapping` (manual overrides first, then shipped rules); unmapped → NULL | `product_master.category_id`; `product_source.source_category` (raw text kept) |
| `gtin`, `isbn` | GTIN-14 canonical (EAN-8/UPC-A/EAN-13/GTIN-14), check digit verified, restricted ranges flagged; ISBN-10 → ISBN-13 | `product_identifier`; `product_master.gtin`, `ean`, `upc`, `isbn` (only a *valid, usable* code); an invalid one is kept as `SOURCE_CODE` |
| `mpn`, `model`, `sku`, `productCode` | alphanumeric key | `product_identifier`; `product_master.mpn`, `model_number`, `sku`, `product_code` |
| `quantityText`, `netWeightText`, `grossWeightText`, `dimensionsText` | `1 kg` = `1000 g` = `1,000 grams` → `1000 g`; multipacks `6 x 200 ml`; dimensions → mm | `product_master.net_quantity_value/unit`, `pack_size`, `pack_count`, `unit_count`, `net_weight_g`, `gross_weight_g`, `volume_ml`, `length_mm/width_mm/height_mm` |
| `color`, `size`, `material`, `shape`, `variant` | colour/size vocabularies; `Free Size` → `FREE` | `product_master.color`, `size`, `material`, `shape`, `variant_name` |
| `gstRate`, `hsnCode`, `cess` | `18%`/`0.18`/`18` → 1800 bp; HSN 4/6/8 digits; legacy slab flagged | `product_master.gst_rate_bp`, `hsn_code`, `cess_bp` |
| `countryOfOrigin` | ISO-style country name | `product_specification` `country_of_origin` (and master projection) |
| `attributes[]` | typed per the attribute registry (number/boolean/text, canonical unit) | `product_specification` — one row **per source**; the preferred value is projected to a master column where the registry says so |
| `description`, `shortDescription` | cleaned text | `product_master.long_description`, `short_description` |
| `images[]` | URL only | `product_image` (licence note per source; nothing copied) |
| `offer` | price/MRP → integer paise; stock → `IN_STOCK`/`LIMITED`/`OUT_OF_STOCK`/`UNKNOWN`; seller key from id else name | `product_offer` (current), `price_history` (on first sighting and every change) |
| *(whole record)* | sanitised JSON + content hash | `raw_record`; hash on `product_source.content_hash` |

## Open Food Facts · Open Beauty Facts · Open Products Facts · Open Pet Food Facts

One adapter (`sources/adapters/open-facts.ts`) serves all four: same schema, same licence. Route: the projects' **official bulk CSV dumps**, filtered to India, streamed and stopped at the row limit. Category rules: `sources/mappings/open-facts.ts`.

| Source column | Staged field | Notes |
|---|---|---|
| `code` | `sourceProductId`, `gtin` | The barcode. No code → `NO_CODE`. 8-digit codes with a bad check digit are common in the data and are kept as `SOURCE_CODE`, not matched on |
| `product_name` ← `generic_name` ← `abbreviated_product_name` | `name` | First non-empty. None → `NO_NAME` (an error row) |
| `brands` | `brand` | Free text, often several brands or a company |
| `brand_owner` | `manufacturer` | **Rarely filled** — the pilot found 14 manufacturers in 2,180 products |
| `categories_tags` ← `categories` | `categories` | Tags first; when a row has none, the free-text field goes through the same rules |
| `generic_name` | `shortDescription` | Only when it differs from `name` |
| `quantity` ← `product_quantity` (grams) | `quantityText` | |
| `origins` ← `manufacturing_places` | `countryOfOrigin` | Where it is **made**. `countries` (where it is *sold*) is deliberately not used |
| `ingredients_text` | attribute `ingredients` | |
| `allergens`, `traces` | `allergen_information`, `traces` | `en:` prefixes removed |
| `serving_size`, `packaging`, `labels` | same-named attributes | |
| `energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`, `fat_100g`, `saturated-fat_100g`, `trans-fat_100g`, `sugars_100g`, `fiber_100g`, `salt_100g`, `sodium_100g` | `energy_kcal_per_100g`, `protein_g_per_100g`, `carbohydrates_g_per_100g`, `total_fat_g_per_100g`, `saturated_fat_g_per_100g`, `trans_fat_g_per_100g`, `sugar_g_per_100g`, `dietary_fiber_g_per_100g`, `salt_g_per_100g`, `sodium_mg_per_100g` | Per 100 g. Sodium arrives in grams and is converted to mg (×1000); the original text is kept |
| `nutriscore_grade` | `nutriscore_grade` | `a`–`e` → `A`–`E`; anything else ignored |
| `nova_group` | `nova_group` | 1–4 only |
| `ingredients_analysis_tags` | `vegan`, `vegetarian_nonveg` | Only **definite** statements: `en:vegan` → true, `en:non-vegan` → false; `maybe-vegan`/`unknown` stay unknown, never true |
| `labels_tags` | `organic` | `en:organic` → true |
| `image_url`, `image_ingredients_url`, `image_nutrition_url` | `images` | Linked, not copied (CC BY-SA) |
| `url` (else `https://world.open*facts.org/product/<code>`) | `sourceUrl` | |
| `completeness` (0–1) | `sourceConfidence` (0–100) | |
| `creator`, `last_modified_by`, contributors / editors / checkers / photographers and similar | — | **Not stored.** Removed before the payload is staged or an error excerpt is written |

**Trust:** reliability 55, specification precedence 60 (lowest of all kinds — any manufacturer, GS1, government, licensed or marketplace value outranks it).

## Open Prices

`sources/adapters/open-prices.ts`. Route: the project's public REST API (empty robots.txt), through the polite client. Each observation is one *offer*. It prices a product the platform already knows by barcode and, when it does not know it, creates the master from the observation's own product fields provided they carry a usable name (`createsProducts: true`) — in the pilot, 36 observations priced existing products and 309 created new masters. A source declared `createsProducts: false` can only price or enrich; a record it cannot attach to a known product is rejected as `NO_MASTER_TO_ATTACH`.

| Source field | Staged field | Notes |
|---|---|---|
| `product_code` ← `product.code` | `sourceProductId`, `gtin` | No barcode → `NO_CODE` |
| `product.product_name`, `product.brands`, `product.quantity`, `product.categories_tags`, `product.image_url` | `name`, `brand`, `quantityText`, `categories`, `images` | Only used to create a master when the product is not yet known |
| `price` | `offer.price` | Rupees. Missing/NaN → `NO_PRICE` |
| `price_per` | — | Anything other than per-unit (e.g. per kilogram) is **skipped** with `PRICE_PER_MEASURE` (a warning): it is not the price of a pack |
| `currency` | `offer.currency` | |
| `location.osm_name` ← `osm_display_name` | `offer.sellerName` | A store from OpenStreetMap |
| `location.osm_type` + `osm_id` | `offer.sellerId` (`osm:<type>:<id>`) | Stable store identity across observations |
| `location.osm_address_city`, `osm_address_country` | `offer.sellerLocation` | |
| `date` | `offer.collectedAt` (midnight UTC) | Missing/invalid → `NO_DATE`. Midnight UTC so a given day is always one instant |
| *(none)* | `offer.stock` = unknown | A shelf price does not prove the item is in stock |
| `owner`, `proof`, contributor references, `product.creator` | — | **Not stored** (people, not products) |
| `type` ≠ `PRODUCT` | — | Category-level prices are skipped (`NOT_A_PRODUCT_PRICE`, a warning) |

**Trust:** reliability 55, precedence 60. A later observation from the same store is **price history**, never a duplicate product; an *older* observation than the current one only back-fills history and never rolls the current price back. The same barcode at a different store is a different seller on the same master.

## Mapped CSV feed (`partner_feed`, `manual_import`)

Described by a mapping file rather than code — see [DATA_SOURCES.md](./DATA_SOURCES.md#a-csv-feed-by-configuration) and the [worked example](./examples/partner-feed.mapping.json). In short, `{ "<staged field>": "<feed column>" }`, with `offer.<field>` for the offer and `attribute.<key>` for category-specific facts.

## Sources that are registered but not yet collectable

Amazon India, Flipkart, Myntra, Meesho, Reliance Digital, Croma, Tata CLiQ, Vijay Sales, BigBasket, Blinkit, Zepto, Swiggy Instamart, JioMart, DMart, Nykaa, FirstCry, Pepperfry, Ajio, Snapdeal, IndiaMART, Moglix, brand sites, GS1, FSSAI, GST, BIS, Legal Metrology and the rest have **no field mapping yet on purpose**: a mapping is written when a lawful route exists (an API, licence or feed with a documented format). The [source register](./SOURCE_REGISTER.md) states each one's route. The target side of every mapping is the table above.
