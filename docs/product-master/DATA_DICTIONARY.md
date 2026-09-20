# Data dictionary - GOKESARI_PRODUCT_MASTER

> Generated from `src/server/pmd/export/model.ts` by `npm run pmd:docs` - do not edit by hand. A unit test fails if this file differs from the code (`tests/unit/pmd-docs.test.ts`).

Every field of the 13 workbook sheets, with its type, whether it is required, where it comes from in the PostgreSQL schema, and what it means. The same definitions feed the workbook's own DATA_DICTIONARY sheet, so the two cannot disagree.

## Conventions

- **Missing data is never zero.** A missing text value is written `NOT_AVAILABLE`; a missing number, date or timestamp is left blank. `0` means zero.
- **Money** is stored as integer minor units (paise) and shown in rupees. **Percentages** are shown as real Excel percentages.
- **Timestamps** are UTC (`yyyy-mm-dd hh:mm:ss`); dates are `yyyy-mm-dd`.
- **List** values are joined with `; `.
- **Required** means the field should be present wherever the data exists; a blank is then highlighted as a data-quality finding.
- **Derived** means computed for the export and not stored on the record (counts, scores, the best current price of a product).
- **Prices are not product attributes.** PRODUCT_MASTER carries no price or MRP; prices live in PRODUCT_SELLER (current offers) and PRODUCT_PRICE_HISTORY.

A fourteenth sheet, **RUN_SUMMARY**, follows the thirteen. It is not part of the brief's structure: it records what the file contains (generation time, scope, row counts per sheet, what a blank means) and carries the Open Database Licence attribution that the open-data sources require whenever their data is redistributed.

## Sheets

| # | Sheet | Fields | Purpose |
| --- | --- | --- | --- |
| 1 | [PRODUCT_MASTER](#1-product_master) | 74 | One row per product (ACTIVE master records). Price and MRP are NOT product attributes: the REFERENCE_* columns are derived from current offers. |
| 2 | [PRODUCT_SPECIFICATIONS](#2-product_specifications) | 12 | One row per product x attribute x source: category-specific facts (food, electronics, apparel...) with provenance. Nothing is overwritten; IS_PREFERRED marks the value in force. |
| 3 | [PRODUCT_SOURCE](#3-product_source) | 21 | One row per source listing: where each product was seen, how it was collected, and how it was tied to a master product. |
| 4 | [PRODUCT_SELLER](#4-product_seller) | 19 | One row per seller offer (current state). The same TV sold by five sellers is one master product and five rows here. Price history is in PRODUCT_PRICE_HISTORY. |
| 5 | [PRODUCT_PRICE_HISTORY](#5-product_price_history) | 11 | Append-only price observations: one row on first sighting and on every change of price, MRP or stock. Supports lowest / highest / average price and seller comparison. |
| 6 | [BRAND_MASTER](#6-brand_master) | 12 | Normalised brands. "Samsung", "SAMSUNG" and "Samsung India" are one brand; every original spelling is preserved in ALIASES. |
| 7 | [MANUFACTURER_MASTER](#7-manufacturer_master) | 12 | Manufacturers / brand owners. Nothing is invented: a blank means no source has supplied it. |
| 8 | [CATEGORY_MASTER](#8-category_master) | 11 | The Gokesari standard taxonomy, five levels deep. |
| 9 | [CATEGORY_MAPPING](#9-category_mapping) | 8 | SOURCE_CATEGORY -> STANDARD_CATEGORY. Manual mappings (MAPPED_BY <> SYSTEM) override the shipped rules. |
| 10 | [PRODUCT_ATTRIBUTE_CONFLICT](#10-product_attribute_conflict) | 11 | Where sources disagree about a fact. Nothing is silently overwritten: manufacturer/brand data is preferred for technical specifications and the rule is recorded; equally authoritative sources stay OPEN for a person. |
| 11 | [DATA_DICTIONARY](#11-data_dictionary) | 9 | The field definitions in this document, as a worksheet. |
| 12 | [DATA_QUALITY](#12-data_quality) | 21 | Per-product data quality: the score, each component, and exactly which fields are missing. Missing data is blank / NOT_AVAILABLE, never zero. |
| 13 | [IMPORT_ERRORS](#13-import_errors) | 9 | Everything that could not be used or deserved a second look during collection: unusable records (ERROR) and repaired or suspicious values (WARNING). The run continues past each one. |

## 1. PRODUCT_MASTER

One row per product (ACTIVE master records). Price and MRP are NOT product attributes: the REFERENCE_* columns are derived from current offers.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Unique Gokesari product id (GKS-PROD-#########). |
| `PRODUCT_NAME` | Text | Yes | No | - | pmd.product_master.product_name | Best available product name (highest-precedence source). |
| `GTIN` | Text | Yes | No | - | pmd.product_master.gtin | Canonical GTIN-14 (EAN-13, UPC-A and GTIN-8 zero-padded). Validated check digit. |
| `EAN` | Text | No | No | - | pmd.product_master.ean | EAN-13 display form of the GTIN, when the code has one. |
| `UPC` | Text | No | No | - | pmd.product_master.upc | UPC-A display form of the GTIN, when the code has one. |
| `ISBN` | Text | No | No | - | pmd.product_master.isbn | ISBN-13 for books. |
| `SKU` | Text | No | No | - | pmd.product_master.sku | Brand / manufacturer SKU. Marketplace SKUs live in PRODUCT_SOURCE. |
| `MPN` | Text | No | No | - | pmd.product_master.mpn | Manufacturer part number. |
| `MODEL_NUMBER` | Text | No | No | - | pmd.product_master.model_number | Manufacturer model number (colour or SIM variants may share one). |
| `PRODUCT_CODE` | Text | No | No | - | pmd.product_master.product_code | Brand product code. |
| `BRAND` | Text | Yes | No | - | pmd.brand.brand_name | Normalised brand (all source spellings kept in BRAND_MASTER aliases). |
| `BRAND_ID` | Text | No | No | - | pmd.brand.brand_code | Brand identifier (GKS-BRND-#########). |
| `MANUFACTURER` | Text | No | No | - | pmd.manufacturer.manufacturer_name | Manufacturer / brand owner. |
| `MANUFACTURER_ID` | Text | No | No | - | pmd.manufacturer.manufacturer_code | Manufacturer identifier (GKS-MFR-#########). |
| `SHORT_DESCRIPTION` | Text | No | No | - | pmd.product_master.short_description | Short description. |
| `LONG_DESCRIPTION` | Text | No | No | - | pmd.product_master.long_description | Long description. |
| `PRODUCT_TYPE` | Text | No | No | - | pmd.product_master.product_type | Product type as classified by the best available source. |
| `SUB_TYPE` | Text | No | No | - | pmd.product_master.sub_type | Product sub-type. |
| `PRODUCT_FAMILY` | Text | No | No | - | pmd.product_family.family_name | Product line grouping pack sizes and variants (same brand, identical core name). |
| `VARIANT_NAME` | Text | No | No | - | pmd.product_master.variant_name | Variant descriptor (flavour, edition...). |
| `VARIANT_CODE` | Text | No | No | - | pmd.product_master.variant_code | Manufacturer or brand variant code. |
| `KEY_FEATURES` | List (values separated by '; ') | No | No | - | pmd.product_master.key_features | Key feature bullets. |
| `SEARCH_KEYWORDS` | List (values separated by '; ') | No | No | - | pmd.product_master.search_keywords | Search keywords. |
| `CATEGORY_LEVEL_1` | Text | Yes | No | - | pmd.category.path_names[1] | Standard category, level 1. |
| `CATEGORY_LEVEL_2` | Text | No | No | - | pmd.category.path_names[2] | Standard category, level 2. |
| `CATEGORY_LEVEL_3` | Text | No | No | - | pmd.category.path_names[3] | Standard category, level 3. |
| `CATEGORY_LEVEL_4` | Text | No | No | - | pmd.category.path_names[4] | Standard category, level 4. |
| `CATEGORY_LEVEL_5` | Text | No | No | - | pmd.category.path_names[5] | Standard category, level 5. |
| `STANDARD_CATEGORY_ID` | Integer | No | No | - | pmd.product_master.category_id | Standard_Category_ID (key into CATEGORY_MASTER). |
| `NET_WEIGHT` | Number | No | No | - | pmd.product_master.net_weight_g | Net weight in grams. |
| `GROSS_WEIGHT` | Number | No | No | - | pmd.product_master.gross_weight_g | Gross weight in grams. |
| `WEIGHT_UNIT` | Text | No | No | - | pmd.product_master.weight_unit | Unit of the weights (always g). |
| `LENGTH` | Number | No | No | - | pmd.product_master.length_mm | Length in millimetres. |
| `WIDTH` | Number | No | No | - | pmd.product_master.width_mm | Width in millimetres. |
| `HEIGHT` | Number | No | No | - | pmd.product_master.height_mm | Height in millimetres. |
| `DIMENSION_UNIT` | Text | No | No | - | pmd.product_master.dimension_unit | Unit of the dimensions (always mm). |
| `VOLUME` | Number | No | No | - | pmd.product_master.volume_ml | Volume in millilitres. |
| `VOLUME_UNIT` | Text | No | No | - | pmd.product_master.volume_unit | Unit of the volume (always ml). |
| `PACK_SIZE` | Text | No | No | - | pmd.product_master.pack_size | Normalised pack size: 1 kg, 1000 g and 1,000 grams all show 1000 g; multipacks show 6 x 200 ml. |
| `PACK_COUNT` | Integer | No | No | - | pmd.product_master.pack_count | Number of units in the pack (multipack multiplier). |
| `UNIT_COUNT` | Integer | No | No | - | pmd.product_master.unit_count | Number of items in a count-type pack. |
| `MATERIAL` | Text | No | No | - | pmd.product_master.material | Primary material. |
| `COLOR` | Text | No | No | - | pmd.product_master.color | Colour (normalised phrase). |
| `SIZE` | Text | No | No | - | pmd.product_master.size | Size, e.g. XL or 32. |
| `SHAPE` | Text | No | No | - | pmd.product_master.shape | Shape or form. |
| `GST_RATE` | Percentage | Yes | No | - | pmd.product_master.gst_rate_bp | GST rate (stored in basis points). |
| `HSN_CODE` | Text | Yes | No | - | pmd.product_master.hsn_code | HSN code, 4/6/8 digits. |
| `CESS` | Percentage | No | No | - | pmd.product_master.cess_bp | Cess rate, shown as a percentage. |
| `OTHER_TAXES` | Text | No | No | - | pmd.product_master.other_taxes | Other taxes (JSON). |
| `REFERENCE_MRP` | Currency (rupees) | No | Yes | - | max(pmd.product_offer.mrp_minor) over current offers | Highest MRP seen across current offers. DERIVED - MRP is per offer and per date, not a product attribute. |
| `REFERENCE_PRICE_MIN` | Currency (rupees) | No | Yes | - | min(pmd.product_offer.price_minor) over current offers | Lowest current selling price. DERIVED. |
| `REFERENCE_PRICE_MAX` | Currency (rupees) | No | Yes | - | max(pmd.product_offer.price_minor) over current offers | Highest current selling price. DERIVED. |
| `REFERENCE_PRICE_AVG` | Currency (rupees) | No | Yes | - | avg(pmd.product_offer.price_minor) over current offers | Average current selling price. DERIVED. |
| `REFERENCE_CURRENCY` | Text | No | Yes | - | pmd.product_offer.currency | Currency of the reference prices. |
| `PRICE_OBSERVED_ON` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | Yes | - | max(pmd.product_offer.collected_at) | When the newest offer was observed. DERIVED. |
| `OFFER_COUNT` | Integer | No | Yes | - | count(pmd.product_offer) where is_current | Current seller offers. DERIVED. |
| `PRODUCT_STATUS` | Text | Yes | No | ACTIVE, OUT_OF_STOCK, DISCONTINUED, TEMPORARILY_UNAVAILABLE, UNKNOWN | pmd.product_master.product_status | ACTIVE / OUT_OF_STOCK / DISCONTINUED / TEMPORARILY_UNAVAILABLE / UNKNOWN. Never DISCONTINUED because one marketplace dropped it. |
| `STATUS_BASIS` | Text | No | No | - | pmd.product_master.status_basis | Why the status has its value. |
| `PRIMARY_IMAGE_URL` | Text | No | No | - | pmd.product_image (rank 0) | Primary image URL. Images are linked, never copied. |
| `IMAGE_URL_1` | Text | No | No | - | pmd.product_image (rank 1) | Additional image 1. |
| `IMAGE_URL_2` | Text | No | No | - | pmd.product_image (rank 2) | Additional image 2. |
| `IMAGE_URL_3` | Text | No | No | - | pmd.product_image (rank 3) | Additional image 3. |
| `IMAGE_URL_4` | Text | No | No | - | pmd.product_image (rank 4) | Additional image 4. |
| `IMAGE_URL_5` | Text | No | No | - | pmd.product_image (rank 5) | Additional image 5. |
| `IMAGE_SOURCE` | Text | No | No | - | pmd.product_image.image_source | Source of the primary image. |
| `IMAGE_VALIDATION_STATUS` | Text | No | No | - | pmd.product_image.validation_status | UNVALIDATED / VALID / BROKEN / RESTRICTED for the primary image. |
| `DATA_QUALITY_SCORE` | Number | Yes | No | - | pmd.product_master.data_quality_score | 0-100 composite (identifier, source reliability, corroboration, completeness, match confidence, recency). |
| `SOURCE_COUNT` | Integer | No | Yes | - | count(pmd.product_source) | Distinct source records linked to this product. DERIVED. |
| `OPEN_CONFLICT_COUNT` | Integer | No | Yes | - | count(pmd.product_attribute_conflict) where OPEN | Unresolved specification conflicts. DERIVED. |
| `FIRST_SEEN_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_master.first_seen_at | First time any source reported this product. |
| `LAST_SEEN_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_master.last_seen_at | Most recent time any source reported it. |
| `CREATED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_master.created_at | Record creation time (UTC). |
| `UPDATED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_master.updated_at | Last time a business field changed (UTC). |
| `VERSION` | Integer | No | No | - | pmd.product_master.version | Increments on every business change; see product_change_log. |

## 2. PRODUCT_SPECIFICATIONS

One row per product x attribute x source: category-specific facts (food, electronics, apparel...) with provenance. Nothing is overwritten; IS_PREFERRED marks the value in force.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Product this fact belongs to. |
| `ATTRIBUTE_KEY` | Text | Yes | No | - | pmd.product_specification.attribute_key | Stable machine key. |
| `ATTRIBUTE_NAME` | Text | Yes | No | - | pmd.attribute_definition.attribute_label | Human-readable attribute label. |
| `ATTRIBUTE_GROUP` | Text | No | No | - | pmd.attribute_definition.attribute_group | FOOD / ELECTRONICS / APPAREL / HOME / BEAUTY / COMPLIANCE / GENERAL / OTHER. |
| `ATTRIBUTE_VALUE` | Text | Yes | No | - | coalesce(value_text, value_num, value_bool) | The value, as text. |
| `UNIT` | Text | No | No | - | pmd.product_specification.unit | Unit of a numeric value. |
| `SOURCE` | Text | Yes | No | - | pmd.source.source_key | Source that supplied this value. |
| `CONFIDENCE_SCORE` | Number | No | No | - | pmd.product_specification.confidence | Source-reported confidence 0-100, when supplied. |
| `IS_PREFERRED` | Yes / No | No | No | - | pmd.product_specification.is_preferred | True for the value currently in force. |
| `ORIGINAL_VALUE` | Text | No | No | - | pmd.product_specification.original_value | The value exactly as the source wrote it. |
| `SOURCE_URL` | Text | No | No | - | pmd.product_specification.source_url | Where the source published it. |
| `COLLECTED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_specification.collected_at | When it was collected (UTC). |

## 3. PRODUCT_SOURCE

One row per source listing: where each product was seen, how it was collected, and how it was tied to a master product.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | No | No | - | pmd.product_master.master_product_id | Linked master product; blank while awaiting review. |
| `SOURCE_NAME` | Text | Yes | No | - | pmd.source.source_key | Source the listing was collected from. |
| `SOURCE_PRODUCT_ID` | Text | Yes | No | - | pmd.product_source.source_product_id | The source's own id (barcode, ASIN, FSN...). |
| `SOURCE_PRODUCT_URL` | Text | No | No | - | pmd.product_source.source_url | Public page for the listing (referenced, not fetched). |
| `SOURCE_CATEGORY` | Text | No | No | - | pmd.product_source.source_category | The source's own category text. |
| `SOURCE_PRODUCT_NAME` | Text | No | No | - | pmd.product_source.source_product_name | Name exactly as the source titled it. |
| `SOURCE_BRAND` | Text | No | No | - | pmd.product_source.source_brand | Brand exactly as the source wrote it. |
| `SOURCE_MRP` | Currency (rupees) | No | No | - | pmd.product_source.source_mrp_minor | MRP the source showed. |
| `SOURCE_PRICE` | Currency (rupees) | No | No | - | pmd.product_source.source_price_minor | Price the source showed. |
| `SOURCE_RATING` | Number | No | No | - | pmd.product_source.source_rating | Average customer rating the source showed. |
| `SOURCE_REVIEW_COUNT` | Integer | No | No | - | pmd.product_source.source_review_count | Number of customer reviews the source showed. |
| `SOURCE_AVAILABILITY` | Text | No | No | - | pmd.product_source.source_availability | Availability text the source showed. |
| `FIRST_SEEN_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_source.first_seen_date | First time collected. |
| `LAST_SEEN_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_source.last_seen_date | Most recent time seen. |
| `DATA_COLLECTION_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_source.data_collection_date | Date of the latest collection. |
| `DATA_COLLECTION_METHOD` | Text | Yes | No | - | pmd.product_source.data_collection_method | How it was collected (OPEN_DATASET_CSV, OFFICIAL_API_JSON, LICENSED_FEED_CSV...). |
| `DATA_CONFIDENCE` | Number | No | No | - | pmd.product_source.data_confidence | Confidence 0-100 (source-reported completeness, else source reliability). |
| `MATCH_STATUS` | Text | No | No | EXACT_MATCH, HIGH_CONFIDENCE, POSSIBLE_MATCH, DIFFERENT_PRODUCT, NEEDS_REVIEW, NO_CANDIDATE | pmd.product_source.match_status | Result of comparing to existing masters. |
| `MATCH_SCORE` | Number | No | No | - | pmd.product_source.match_score | Match score 0-100 against the best candidate. |
| `MATCH_RULE` | Text | No | No | - | pmd.product_source.match_rule | Which rule decided (L1_GTIN_BRAND, L3_STRUCTURED, ...). |
| `RESOLUTION` | Text | No | No | LINKED_EXISTING, CREATED_NEW, PENDING_REVIEW, MANUAL_LINK | pmd.product_source.resolution | LINKED_EXISTING / CREATED_NEW / PENDING_REVIEW / MANUAL_LINK. |

## 4. PRODUCT_SELLER

One row per seller offer (current state). The same TV sold by five sellers is one master product and five rows here. Price history is in PRODUCT_PRICE_HISTORY.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Product being offered. |
| `SOURCE` | Text | Yes | No | - | pmd.source.source_key | Marketplace / feed the offer was seen on. |
| `SOURCE_PRODUCT_ID` | Text | No | No | - | pmd.product_offer.source_product_id | The source listing id. |
| `SELLER_ID` | Text | No | No | - | pmd.product_offer.seller_id | Seller id in the source. |
| `SELLER_NAME` | Text | No | No | - | pmd.product_offer.seller_name | Name of the seller making the offer. |
| `SELLER_LOCATION` | Text | No | No | - | pmd.product_offer.seller_location | Seller location. |
| `SELLER_RATING` | Number | No | No | - | pmd.product_offer.seller_rating | Seller rating (0-5). |
| `PRICE` | Currency (rupees) | No | No | - | pmd.product_offer.price_minor | Selling price (stored as integer minor units, shown in rupees). |
| `MRP` | Currency (rupees) | No | No | - | pmd.product_offer.mrp_minor | MRP shown by this seller. |
| `DISCOUNT` | Currency (rupees) | No | No | - | pmd.product_offer.discount_minor | MRP minus price. |
| `DISCOUNT_PERCENTAGE` | Percentage | No | No | - | pmd.product_offer.discount_pct | Discount as a percentage of MRP. |
| `CURRENCY` | Text | No | No | - | pmd.product_offer.currency | ISO currency code of the amounts. |
| `TAX_INCLUSIVE` | Yes / No | No | No | - | pmd.product_offer.tax_inclusive | Whether the price includes tax. |
| `STOCK_STATUS` | Text | No | No | IN_STOCK, OUT_OF_STOCK, LIMITED, UNKNOWN | pmd.product_offer.stock_status | Stock status. UNKNOWN when the source does not say. |
| `DELIVERY_INFORMATION` | Text | No | No | - | pmd.product_offer.delivery_information | Delivery information. |
| `SOURCE_URL` | Text | No | No | - | pmd.product_offer.source_url | Offer / listing page. |
| `COLLECTION_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.product_offer.collection_date | Date of the latest observation. |
| `COLLECTION_TIMESTAMP` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_offer.collected_at | Timestamp of the latest observation (UTC). |
| `IS_CURRENT` | Yes / No | No | No | - | pmd.product_offer.is_current | False when the source stopped listing the offer. |

## 5. PRODUCT_PRICE_HISTORY

Append-only price observations: one row on first sighting and on every change of price, MRP or stock. Supports lowest / highest / average price and seller comparison.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Product the price observation belongs to. |
| `SOURCE` | Text | Yes | No | - | pmd.source.source_key | Source that reported the price. |
| `SELLER` | Text | No | No | - | pmd.price_history.seller_name | Seller the price was observed at. |
| `MRP` | Currency (rupees) | No | No | - | pmd.price_history.mrp_minor | MRP at the time. |
| `SELLING_PRICE` | Currency (rupees) | Yes | No | - | pmd.price_history.selling_price_minor | Selling price at the time. |
| `DISCOUNT` | Currency (rupees) | No | No | - | pmd.price_history.discount_minor | MRP minus price at the time. |
| `CURRENCY` | Text | No | No | - | pmd.price_history.currency | ISO currency code of the amounts. |
| `STOCK_STATUS` | Text | No | No | IN_STOCK, OUT_OF_STOCK, LIMITED, UNKNOWN | pmd.price_history.stock_status | Stock status at the time. |
| `CHANGE_REASON` | Text | No | No | - | pmd.price_history.change_reason | FIRST_SEEN / PRICE_CHANGED / MRP_CHANGED / STOCK_CHANGED / PRICE_AND_STOCK_CHANGED. |
| `COLLECTION_DATE` | Date (yyyy-mm-dd) | No | No | - | pmd.price_history.collection_date | Observation date. |
| `COLLECTION_TIMESTAMP` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.price_history.collected_at | Observation timestamp (UTC). |

## 6. BRAND_MASTER

Normalised brands. "Samsung", "SAMSUNG" and "Samsung India" are one brand; every original spelling is preserved in ALIASES.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `BRAND_ID` | Text | Yes | No | - | pmd.brand.brand_code | Brand id (GKS-BRND-#########). |
| `BRAND_NAME` | Text | Yes | No | - | pmd.brand.brand_name | Canonical brand name. |
| `LEGAL_COMPANY_NAME` | Text | No | No | - | pmd.brand.legal_company_name | Legal company name, when known. |
| `MANUFACTURER` | Text | No | No | - | pmd.manufacturer.manufacturer_name | Owning manufacturer, when known. |
| `COUNTRY` | Text | No | No | - | pmd.brand.country | Brand country, when a source states it. |
| `WEBSITE` | Text | No | No | - | pmd.brand.website | Official brand website, when known. |
| `CATEGORY` | Text | No | No | - | pmd.category.name | Primary category, when known. |
| `BRAND_STATUS` | Text | No | No | ACTIVE, INACTIVE, UNVERIFIED | pmd.brand.brand_status | ACTIVE / INACTIVE / UNVERIFIED. |
| `SOURCE` | Text | No | No | - | pmd.source.source_key | Source that first reported the brand. |
| `VERIFICATION_STATUS` | Text | No | No | UNVERIFIED, VERIFIED, DISPUTED | pmd.brand.verification_status | UNVERIFIED / VERIFIED / DISPUTED. |
| `ALIASES` | List (values separated by '; ') | No | No | - | pmd.brand_alias.alias_original | Every spelling seen in sources (originals preserved). |
| `PRODUCT_COUNT` | Integer | No | Yes | - | count(pmd.product_master) | ACTIVE products. DERIVED. |

## 7. MANUFACTURER_MASTER

Manufacturers / brand owners. Nothing is invented: a blank means no source has supplied it.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MANUFACTURER_ID` | Text | Yes | No | - | pmd.manufacturer.manufacturer_code | Manufacturer id (GKS-MFR-#########). |
| `MANUFACTURER_NAME` | Text | Yes | No | - | pmd.manufacturer.manufacturer_name | Canonical name. |
| `LEGAL_NAME` | Text | No | No | - | pmd.manufacturer.legal_name | Registered legal name. |
| `ADDRESS` | Text | No | No | - | pmd.manufacturer.address | Address (only where publicly published). |
| `COUNTRY` | Text | No | No | - | pmd.manufacturer.country | Manufacturer country, when a source states it. |
| `GSTIN` | Text | No | No | - | pmd.manufacturer.gstin | GSTIN, structure-validated. Registration status is not verified. |
| `WEBSITE` | Text | No | No | - | pmd.manufacturer.website | Official manufacturer website, when known. |
| `CONTACT_INFORMATION` | Text | No | No | - | pmd.manufacturer.contact_information | Public business contact only. |
| `SOURCE` | Text | No | No | - | pmd.source.source_key | Source that first reported it. |
| `VERIFICATION_STATUS` | Text | No | No | UNVERIFIED, VERIFIED, DISPUTED | pmd.manufacturer.verification_status | UNVERIFIED / VERIFIED / DISPUTED. |
| `ALIASES` | List (values separated by '; ') | No | No | - | pmd.manufacturer_alias.alias_original | Every spelling seen in sources. |
| `BRAND_COUNT` | Integer | No | Yes | - | count(pmd.brand) | Brands owned. DERIVED. |

## 8. CATEGORY_MASTER

The Gokesari standard taxonomy, five levels deep.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `STANDARD_CATEGORY_ID` | Integer | Yes | No | - | pmd.category.category_id | Standard_Category_ID. |
| `CATEGORY_CODE` | Text | Yes | No | - | pmd.category.category_code | Stable slug path. |
| `LEVEL` | Integer | Yes | No | - | pmd.category.level | Depth in the taxonomy: 1 (top) to 5. |
| `CATEGORY_LEVEL_1` | Text | No | No | - | pmd.category.path_names[1] | Category, level 1. |
| `CATEGORY_LEVEL_2` | Text | No | No | - | pmd.category.path_names[2] | Category, level 2. |
| `CATEGORY_LEVEL_3` | Text | No | No | - | pmd.category.path_names[3] | Category, level 3. |
| `CATEGORY_LEVEL_4` | Text | No | No | - | pmd.category.path_names[4] | Category, level 4. |
| `CATEGORY_LEVEL_5` | Text | No | No | - | pmd.category.path_names[5] | Category, level 5. |
| `PARENT_CATEGORY_ID` | Integer | No | No | - | pmd.category.parent_id | STANDARD_CATEGORY_ID of the parent node. |
| `GOKESARI_DEPARTMENT` | Text | No | No | - | pmd.category.gokesari_department | Closest GoKesari shop type (guides promotion into the catalogue). |
| `PRODUCT_COUNT` | Integer | No | Yes | - | count(pmd.product_master) | ACTIVE products at exactly this node. DERIVED. |

## 9. CATEGORY_MAPPING

SOURCE_CATEGORY -> STANDARD_CATEGORY. Manual mappings (MAPPED_BY <> SYSTEM) override the shipped rules.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `SOURCE` | Text | Yes | No | - | pmd.source.source_key | Source whose category is being mapped. |
| `SOURCE_CATEGORY` | Text | Yes | No | - | pmd.category_mapping.source_category | Normalised source category (lookup key). |
| `SOURCE_CATEGORY_ORIGINAL` | Text | No | No | - | pmd.category_mapping.source_category_original | As the source wrote it. |
| `STANDARD_CATEGORY_ID` | Integer | Yes | No | - | pmd.category_mapping.standard_category_id | Standard category the source category maps to. |
| `STANDARD_CATEGORY_PATH` | Text | No | No | - | array_to_string(pmd.category.path_names, ' > ') | Target node, spelled out. |
| `MATCH_TYPE` | Text | No | No | - | pmd.category_mapping.match_type | EXACT / PREFIX / KEYWORD / MANUAL. |
| `CONFIDENCE` | Number | No | No | - | pmd.category_mapping.confidence | Confidence 0-100. |
| `MAPPED_BY` | Text | No | No | - | pmd.category_mapping.mapped_by | SYSTEM or the steward who set it. |

## 10. PRODUCT_ATTRIBUTE_CONFLICT

Where sources disagree about a fact. Nothing is silently overwritten: manufacturer/brand data is preferred for technical specifications and the rule is recorded; equally authoritative sources stay OPEN for a person.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Product the disagreement is about. |
| `ATTRIBUTE_NAME` | Text | Yes | No | - | pmd.attribute_definition.attribute_label | Attribute in dispute. |
| `VALUE_1` | Text | Yes | No | - | pmd.product_attribute_conflict.value_1 | The preferred (winning) source's value. |
| `SOURCE_1` | Text | Yes | No | - | pmd.product_attribute_conflict.source_1 | Source of VALUE_1. |
| `VALUE_2` | Text | Yes | No | - | pmd.product_attribute_conflict.value_2 | The disagreeing value. |
| `SOURCE_2` | Text | Yes | No | - | pmd.product_attribute_conflict.source_2 | Source of VALUE_2. |
| `CONFLICT_STATUS` | Text | Yes | No | OPEN, AUTO_RESOLVED, MANUALLY_RESOLVED, IGNORED | pmd.product_attribute_conflict.conflict_status | OPEN / AUTO_RESOLVED / MANUALLY_RESOLVED / IGNORED. |
| `RESOLUTION` | Text | No | No | - | pmd.product_attribute_conflict.resolution | How it was resolved. |
| `RESOLUTION_SOURCE` | Text | No | No | - | pmd.product_attribute_conflict.resolution_source | RULE:SPEC_PRECEDENCE, RULE:CONVERGED, MERGE, or a steward. |
| `RESOLUTION_DATE` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_attribute_conflict.resolution_date | When it was resolved (UTC). |
| `DETECTED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_attribute_conflict.detected_at | When it was detected (UTC). |

## 11. DATA_DICTIONARY

The field definitions in this document, as a worksheet. It is generated from the model, not queried.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `SHEET` | Text | Yes | No | - | export model | Worksheet name. |
| `FIELD` | Text | Yes | No | - | export model | Column header as it appears in the sheet. |
| `DATA_TYPE` | Text | No | No | - | export model | How values are stored and formatted. |
| `REQUIRED` | Text | No | No | Yes, No | export model | Yes when the field should be present wherever the data exists; blanks are then highlighted. |
| `DERIVED` | Text | No | No | Yes, No | export model | Yes when computed for the export and not stored on the record. |
| `MISSING_VALUE` | Text | No | No | - | export model | How a missing value is shown: NOT_AVAILABLE for text, blank for numbers and dates. Never 0. |
| `ALLOWED_VALUES` | Text | No | No | - | export model | Enumerated values (also enforced by Excel data validation). |
| `DATABASE_SOURCE` | Text | No | No | - | export model | Table.column or derivation in the PostgreSQL schema. |
| `DESCRIPTION` | Text | No | No | - | export model | What the field means. |

## 12. DATA_QUALITY

Per-product data quality: the score, each component, and exactly which fields are missing. Missing data is blank / NOT_AVAILABLE, never zero.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_PRODUCT_ID` | Text | Yes | No | - | pmd.product_master.master_product_id | Product being scored. |
| `PRODUCT_NAME` | Text | No | No | - | pmd.product_master.product_name | Product name, for readability. |
| `DATA_QUALITY_SCORE` | Number | Yes | No | - | pmd.product_master.data_quality_score | 0-100 composite. |
| `IDENTIFIER_SCORE` | Number | No | No | - | quality_components.identifier | Identifier strength (valid GTIN = 100). |
| `SOURCE_RELIABILITY_SCORE` | Number | No | No | - | quality_components.sourceReliability | Best source's reliability. |
| `CORROBORATION_SCORE` | Number | No | No | - | quality_components.corroboration | Number of independent sources. |
| `COMPLETENESS_SCORE` | Number | No | No | - | quality_components.completeness | Share of expected fields present for this kind of product. |
| `MATCH_CONFIDENCE_SCORE` | Number | No | No | - | quality_components.matchConfidence | Confidence the linked records are one product. Blank = not recorded. |
| `RECENCY_SCORE` | Number | No | No | - | quality_components.recency | How recently a source saw it. |
| `MISSING_FIELDS` | List (values separated by '; ') | No | No | - | quality_components.missingFields | Fields expected but absent. |
| `SOURCE_COUNT` | Integer | No | Yes | - | count(pmd.product_source) | Linked sources. DERIVED. |
| `HAS_GTIN` | Yes / No | No | Yes | - | pmd.product_master.gtin is not null | Valid GTIN present. DERIVED. |
| `HAS_BRAND` | Yes / No | No | Yes | - | pmd.product_master.brand_id is not null | Brand present. DERIVED. |
| `HAS_MANUFACTURER` | Yes / No | No | Yes | - | pmd.product_master.manufacturer_id is not null | Manufacturer present. DERIVED. |
| `HAS_CATEGORY` | Yes / No | No | Yes | - | pmd.product_master.category_id is not null | Standard category present. DERIVED. |
| `HAS_MRP_OBSERVATION` | Yes / No | No | Yes | - | any offer/source with an MRP | An MRP has been observed somewhere. DERIVED. |
| `HAS_GST` | Yes / No | No | Yes | - | pmd.product_master.gst_rate_bp is not null | GST rate present. DERIVED. |
| `HAS_HSN` | Yes / No | No | Yes | - | pmd.product_master.hsn_code is not null | HSN present. DERIVED. |
| `OPEN_CONFLICTS` | Integer | No | Yes | - | count(pmd.product_attribute_conflict) OPEN | Unresolved conflicts. DERIVED. |
| `PENDING_REVIEW_ITEMS` | Integer | No | Yes | - | count(pmd.match_candidate) PENDING | Possible-duplicate items awaiting a person. DERIVED. |
| `QUALITY_COMPUTED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.product_master.quality_computed_at | When the score was computed (UTC). |

## 13. IMPORT_ERRORS

Everything that could not be used or deserved a second look during collection: unusable records (ERROR) and repaired or suspicious values (WARNING). The run continues past each one.

| Field | Type | Required | Derived | Allowed values | Database source | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `RUN_ID` | Integer | Yes | No | - | pmd.import_error.run_id | Ingestion run. |
| `SOURCE` | Text | Yes | No | - | pmd.source.source_key | Source of the record that failed or was repaired. |
| `SOURCE_RECORD_ID` | Text | No | No | - | pmd.import_error.source_record_id | The source's own id for the record. |
| `STAGE` | Text | Yes | No | - | pmd.import_error.stage | Pipeline stage: EXTRACT / PARSE / NORMALIZE / MATCH / VALIDATE / LOAD. |
| `SEVERITY` | Text | Yes | No | ERROR, WARNING | pmd.import_error.severity | ERROR (record not loaded) or WARNING (loaded, value repaired or flagged). |
| `ERROR_CODE` | Text | Yes | No | - | pmd.import_error.error_code | Machine-readable error code. |
| `MESSAGE` | Text | Yes | No | - | pmd.import_error.message | Human-readable explanation of the problem. |
| `CREATED_AT` | Timestamp UTC (yyyy-mm-dd hh:mm:ss) | No | No | - | pmd.import_error.created_at | When it was logged (UTC). |
| `RAW_EXCERPT` | Text | No | No | - | pmd.import_error.raw_excerpt | Start of the offending value or record (personal data already stripped). |
