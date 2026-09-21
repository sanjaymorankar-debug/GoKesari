/**
 * The workbook model: every sheet, every column, in one place.
 *
 * This single definition drives three things, so they cannot disagree:
 *   1. the SQL that feeds each sheet,
 *   2. the cell formatting (dates, money, percentages, NOT_AVAILABLE),
 *   3. the DATA_DICTIONARY sheet and docs.
 *
 * Column keys are the SQL aliases; headers are the UPPER_SNAKE names from the brief.
 * Money leaves PostgreSQL as integer minor units and is shown in rupees; percentages
 * leave as 0-100 (or basis points) and are shown as real Excel percentages.
 */

export type ColType = "text" | "int" | "number" | "date" | "timestamp" | "money" | "percent" | "bool" | "list";

export interface ColumnDef {
  key: string;
  header: string;
  type: ColType;
  description: string;
  /** Where the value comes from: table.column, or a derivation. */
  source: string;
  /** Present for every product when the data exists; a blank here is a data-quality finding. */
  required?: boolean;
  /** Computed for the export (never stored on the product): prices, counts, scores. */
  derived?: boolean;
  /** Fixed value list -> Excel data validation. */
  allowed?: readonly string[];
  width?: number;
}

export interface SheetScope {
  fromProductId?: number;
  toProductId?: number;
}

export interface SheetDef {
  name: string;
  tableName: string;
  description: string;
  /** Freeze the header row and this many leading columns. */
  freezeColumns: number;
  columns: ColumnDef[];
  /** SQL producing exactly `columns[].key` as aliases. */
  query: (scope: SheetScope) => string;
}

const C = (
  key: string,
  header: string,
  type: ColType,
  source: string,
  description: string,
  extra: Partial<ColumnDef> = {},
): ColumnDef => ({ key, header, type, source, description, ...extra });

const STOCK = ["IN_STOCK", "OUT_OF_STOCK", "LIMITED", "UNKNOWN"] as const;
const VERIFY = ["UNVERIFIED", "VERIFIED", "DISPUTED"] as const;
const PRODUCT_STATUS = ["ACTIVE", "OUT_OF_STOCK", "DISCONTINUED", "TEMPORARILY_UNAVAILABLE", "UNKNOWN"] as const;
const MATCH_STATUS = ["EXACT_MATCH", "HIGH_CONFIDENCE", "POSSIBLE_MATCH", "DIFFERENT_PRODUCT", "NEEDS_REVIEW", "NO_CANDIDATE"] as const;
const CONFLICT_STATUS = ["OPEN", "AUTO_RESOLVED", "MANUALLY_RESOLVED", "IGNORED"] as const;

const range = (col: string, s: SheetScope) =>
  [s.fromProductId != null ? `${col} >= ${Number(s.fromProductId)}` : null, s.toProductId != null ? `${col} <= ${Number(s.toProductId)}` : null].filter(Boolean).join(" AND ") || "true";

/* ------------------------------------------------------------- PRODUCT_MASTER */

const productMaster: SheetDef = {
  name: "PRODUCT_MASTER",
  tableName: "tblProductMaster",
  description: "One row per product (ACTIVE master records). Price and MRP are NOT product attributes: the REFERENCE_* columns are derived from current offers.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Unique Gokesari product id (GKS-PROD-#########).", { required: true, width: 20 }),
    C("product_name", "PRODUCT_NAME", "text", "pmd.product_master.product_name", "Best available product name (highest-precedence source).", { required: true, width: 44 }),
    C("gtin", "GTIN", "text", "pmd.product_master.gtin", "Canonical GTIN-14 (EAN-13, UPC-A and GTIN-8 zero-padded). Validated check digit.", { required: true }),
    C("ean", "EAN", "text", "pmd.product_master.ean", "EAN-13 display form of the GTIN, when the code has one."),
    C("upc", "UPC", "text", "pmd.product_master.upc", "UPC-A display form of the GTIN, when the code has one."),
    C("isbn", "ISBN", "text", "pmd.product_master.isbn", "ISBN-13 for books."),
    C("sku", "SKU", "text", "pmd.product_master.sku", "Brand / manufacturer SKU. Marketplace SKUs live in PRODUCT_SOURCE."),
    C("mpn", "MPN", "text", "pmd.product_master.mpn", "Manufacturer part number."),
    C("model_number", "MODEL_NUMBER", "text", "pmd.product_master.model_number", "Manufacturer model number (colour or SIM variants may share one)."),
    C("product_code", "PRODUCT_CODE", "text", "pmd.product_master.product_code", "Brand product code."),
    C("brand", "BRAND", "text", "pmd.brand.brand_name", "Normalised brand (all source spellings kept in BRAND_MASTER aliases).", { required: true }),
    C("brand_id", "BRAND_ID", "text", "pmd.brand.brand_code", "Brand identifier (GKS-BRND-#########)."),
    C("manufacturer", "MANUFACTURER", "text", "pmd.manufacturer.manufacturer_name", "Manufacturer / brand owner."),
    C("manufacturer_id", "MANUFACTURER_ID", "text", "pmd.manufacturer.manufacturer_code", "Manufacturer identifier (GKS-MFR-#########)."),
    C("short_description", "SHORT_DESCRIPTION", "text", "pmd.product_master.short_description", "Short description."),
    C("long_description", "LONG_DESCRIPTION", "text", "pmd.product_master.long_description", "Long description.", { width: 40 }),
    C("product_type", "PRODUCT_TYPE", "text", "pmd.product_master.product_type", "Product type as classified by the best available source."),
    C("sub_type", "SUB_TYPE", "text", "pmd.product_master.sub_type", "Product sub-type."),
    C("product_family", "PRODUCT_FAMILY", "text", "pmd.product_family.family_name", "Product line grouping pack sizes and variants (same brand, identical core name)."),
    C("variant_name", "VARIANT_NAME", "text", "pmd.product_master.variant_name", "Variant descriptor (flavour, edition...)."),
    C("variant_code", "VARIANT_CODE", "text", "pmd.product_master.variant_code", "Manufacturer or brand variant code."),
    C("key_features", "KEY_FEATURES", "list", "pmd.product_master.key_features", "Key feature bullets."),
    C("search_keywords", "SEARCH_KEYWORDS", "list", "pmd.product_master.search_keywords", "Search keywords."),
    C("category_level_1", "CATEGORY_LEVEL_1", "text", "pmd.category.path_names[1]", "Standard category, level 1.", { required: true }),
    C("category_level_2", "CATEGORY_LEVEL_2", "text", "pmd.category.path_names[2]", "Standard category, level 2."),
    C("category_level_3", "CATEGORY_LEVEL_3", "text", "pmd.category.path_names[3]", "Standard category, level 3."),
    C("category_level_4", "CATEGORY_LEVEL_4", "text", "pmd.category.path_names[4]", "Standard category, level 4."),
    C("category_level_5", "CATEGORY_LEVEL_5", "text", "pmd.category.path_names[5]", "Standard category, level 5."),
    C("standard_category_id", "STANDARD_CATEGORY_ID", "int", "pmd.product_master.category_id", "Standard_Category_ID (key into CATEGORY_MASTER)."),
    C("net_weight", "NET_WEIGHT", "number", "pmd.product_master.net_weight_g", "Net weight in grams."),
    C("gross_weight", "GROSS_WEIGHT", "number", "pmd.product_master.gross_weight_g", "Gross weight in grams."),
    C("weight_unit", "WEIGHT_UNIT", "text", "pmd.product_master.weight_unit", "Unit of the weights (always g)."),
    C("length", "LENGTH", "number", "pmd.product_master.length_mm", "Length in millimetres."),
    C("width", "WIDTH", "number", "pmd.product_master.width_mm", "Width in millimetres."),
    C("height", "HEIGHT", "number", "pmd.product_master.height_mm", "Height in millimetres."),
    C("dimension_unit", "DIMENSION_UNIT", "text", "pmd.product_master.dimension_unit", "Unit of the dimensions (always mm)."),
    C("volume", "VOLUME", "number", "pmd.product_master.volume_ml", "Volume in millilitres."),
    C("volume_unit", "VOLUME_UNIT", "text", "pmd.product_master.volume_unit", "Unit of the volume (always ml)."),
    C("pack_size", "PACK_SIZE", "text", "pmd.product_master.pack_size", "Normalised pack size: 1 kg, 1000 g and 1,000 grams all show 1000 g; multipacks show 6 x 200 ml."),
    C("pack_count", "PACK_COUNT", "int", "pmd.product_master.pack_count", "Number of units in the pack (multipack multiplier)."),
    C("unit_count", "UNIT_COUNT", "int", "pmd.product_master.unit_count", "Number of items in a count-type pack."),
    C("material", "MATERIAL", "text", "pmd.product_master.material", "Primary material."),
    C("color", "COLOR", "text", "pmd.product_master.color", "Colour (normalised phrase)."),
    C("size", "SIZE", "text", "pmd.product_master.size", "Size, e.g. XL or 32."),
    C("shape", "SHAPE", "text", "pmd.product_master.shape", "Shape or form."),
    C("gst_rate", "GST_RATE", "percent", "pmd.product_master.gst_rate_bp", "GST rate (stored in basis points).", { required: true }),
    C("hsn_code", "HSN_CODE", "text", "pmd.product_master.hsn_code", "HSN code, 4/6/8 digits.", { required: true }),
    C("cess", "CESS", "percent", "pmd.product_master.cess_bp", "Cess rate, shown as a percentage."),
    C("other_taxes", "OTHER_TAXES", "text", "pmd.product_master.other_taxes", "Other taxes (JSON)."),
    C("reference_mrp", "REFERENCE_MRP", "money", "max(pmd.product_offer.mrp_minor) over current offers", "Highest MRP seen across current offers. DERIVED - MRP is per offer and per date, not a product attribute.", { derived: true }),
    C("reference_price_min", "REFERENCE_PRICE_MIN", "money", "min(pmd.product_offer.price_minor) over current offers", "Lowest current selling price. DERIVED.", { derived: true }),
    C("reference_price_max", "REFERENCE_PRICE_MAX", "money", "max(pmd.product_offer.price_minor) over current offers", "Highest current selling price. DERIVED.", { derived: true }),
    C("reference_price_avg", "REFERENCE_PRICE_AVG", "money", "avg(pmd.product_offer.price_minor) over current offers", "Average current selling price. DERIVED.", { derived: true }),
    C("reference_currency", "REFERENCE_CURRENCY", "text", "pmd.product_offer.currency", "Currency of the reference prices.", { derived: true }),
    C("price_observed_on", "PRICE_OBSERVED_ON", "timestamp", "max(pmd.product_offer.collected_at)", "When the newest offer was observed. DERIVED.", { derived: true }),
    C("offer_count", "OFFER_COUNT", "int", "count(pmd.product_offer) where is_current", "Current seller offers. DERIVED.", { derived: true }),
    C("product_status", "PRODUCT_STATUS", "text", "pmd.product_master.product_status", "ACTIVE / OUT_OF_STOCK / DISCONTINUED / TEMPORARILY_UNAVAILABLE / UNKNOWN. Never DISCONTINUED because one marketplace dropped it.", { required: true, allowed: PRODUCT_STATUS }),
    C("status_basis", "STATUS_BASIS", "text", "pmd.product_master.status_basis", "Why the status has its value."),
    C("primary_image_url", "PRIMARY_IMAGE_URL", "text", "pmd.product_image (rank 0)", "Primary image URL. Images are linked, never copied."),
    C("image_url_1", "IMAGE_URL_1", "text", "pmd.product_image (rank 1)", "Additional image 1."),
    C("image_url_2", "IMAGE_URL_2", "text", "pmd.product_image (rank 2)", "Additional image 2."),
    C("image_url_3", "IMAGE_URL_3", "text", "pmd.product_image (rank 3)", "Additional image 3."),
    C("image_url_4", "IMAGE_URL_4", "text", "pmd.product_image (rank 4)", "Additional image 4."),
    C("image_url_5", "IMAGE_URL_5", "text", "pmd.product_image (rank 5)", "Additional image 5."),
    C("image_source", "IMAGE_SOURCE", "text", "pmd.product_image.image_source", "Source of the primary image."),
    C("image_validation_status", "IMAGE_VALIDATION_STATUS", "text", "pmd.product_image.validation_status", "UNVALIDATED / VALID / BROKEN / RESTRICTED for the primary image."),
    C("data_quality_score", "DATA_QUALITY_SCORE", "number", "pmd.product_master.data_quality_score", "0-100 composite (identifier, source reliability, corroboration, completeness, match confidence, recency).", { required: true }),
    C("source_count", "SOURCE_COUNT", "int", "count(pmd.product_source)", "Distinct source records linked to this product. DERIVED.", { derived: true }),
    C("open_conflict_count", "OPEN_CONFLICT_COUNT", "int", "count(pmd.product_attribute_conflict) where OPEN", "Unresolved specification conflicts. DERIVED.", { derived: true }),
    C("first_seen_date", "FIRST_SEEN_DATE", "date", "pmd.product_master.first_seen_at", "First time any source reported this product."),
    C("last_seen_date", "LAST_SEEN_DATE", "date", "pmd.product_master.last_seen_at", "Most recent time any source reported it."),
    C("created_at", "CREATED_AT", "timestamp", "pmd.product_master.created_at", "Record creation time (UTC)."),
    C("updated_at", "UPDATED_AT", "timestamp", "pmd.product_master.updated_at", "Last time a business field changed (UTC)."),
    C("version", "VERSION", "int", "pmd.product_master.version", "Increments on every business change; see product_change_log."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, pm.product_name, pm.gtin, pm.ean, pm.upc, pm.isbn, pm.sku, pm.mpn, pm.model_number, pm.product_code,
           pm.brand_name AS brand, pm.brand_code AS brand_id, pm.manufacturer_name AS manufacturer, pm.manufacturer_code AS manufacturer_id,
           pm.short_description, pm.long_description, pm.product_type, pm.sub_type, pm.product_family, pm.variant_name, pm.variant_code,
           ARRAY(SELECT jsonb_array_elements_text(pm.key_features)) AS key_features, pm.search_keywords,
           pm.category_level_1, pm.category_level_2, pm.category_level_3, pm.category_level_4, pm.category_level_5, pm.category_id AS standard_category_id,
           pm.net_weight_g AS net_weight, pm.gross_weight_g AS gross_weight, pm.weight_unit, pm.length_mm AS length, pm.width_mm AS width,
           pm.height_mm AS height, pm.dimension_unit, pm.volume_ml AS volume, pm.volume_unit, pm.pack_size, pm.pack_count, pm.unit_count,
           pm.material, pm.color, pm.size, pm.shape, pm.gst_rate_bp AS gst_rate, pm.hsn_code, pm.cess_bp AS cess, pm.other_taxes::text AS other_taxes,
           ps.max_mrp_minor AS reference_mrp, ps.min_price_minor AS reference_price_min, ps.max_price_minor AS reference_price_max,
           ps.avg_price_minor AS reference_price_avg, ps.currency AS reference_currency, ps.last_collected_at AS price_observed_on, ps.offer_count,
           pm.product_status, pm.status_basis,
           img.p0 AS primary_image_url, img.i1 AS image_url_1, img.i2 AS image_url_2, img.i3 AS image_url_3, img.i4 AS image_url_4, img.i5 AS image_url_5,
           img.image_source, img.validation_status AS image_validation_status,
           pm.data_quality_score,
           (SELECT count(*)::int FROM pmd.product_source x WHERE x.product_id = pm.product_id) AS source_count,
           (SELECT count(*)::int FROM pmd.product_attribute_conflict x WHERE x.product_id = pm.product_id AND x.conflict_status = 'OPEN') AS open_conflict_count,
           pm.first_seen_at AS first_seen_date, pm.last_seen_at AS last_seen_date, pm.created_at, pm.updated_at, pm.version
    FROM pmd.v_product_flat pm
    LEFT JOIN pmd.v_product_price_summary ps ON ps.product_id = pm.product_id
    LEFT JOIN LATERAL (
      SELECT max(image_url) FILTER (WHERE rank = 0) p0, max(image_url) FILTER (WHERE rank = 1) i1, max(image_url) FILTER (WHERE rank = 2) i2,
             max(image_url) FILTER (WHERE rank = 3) i3, max(image_url) FILTER (WHERE rank = 4) i4, max(image_url) FILTER (WHERE rank = 5) i5,
             max(image_source) FILTER (WHERE rank = 0) image_source, max(validation_status) FILTER (WHERE rank = 0) validation_status
      FROM pmd.product_image WHERE product_id = pm.product_id) img ON true
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id`,
};

/* ------------------------------------------------------ PRODUCT_SPECIFICATIONS */

const specifications: SheetDef = {
  name: "PRODUCT_SPECIFICATIONS",
  tableName: "tblProductSpecifications",
  description: "One row per product x attribute x source: category-specific facts (food, electronics, apparel...) with provenance. Nothing is overwritten; IS_PREFERRED marks the value in force.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Product this fact belongs to.", { required: true, width: 20 }),
    C("attribute_key", "ATTRIBUTE_KEY", "text", "pmd.product_specification.attribute_key", "Stable machine key.", { required: true }),
    C("attribute_name", "ATTRIBUTE_NAME", "text", "pmd.attribute_definition.attribute_label", "Human-readable attribute label.", { required: true, width: 30 }),
    C("attribute_group", "ATTRIBUTE_GROUP", "text", "pmd.attribute_definition.attribute_group", "FOOD / ELECTRONICS / APPAREL / HOME / BEAUTY / COMPLIANCE / GENERAL / OTHER."),
    C("attribute_value", "ATTRIBUTE_VALUE", "text", "coalesce(value_text, value_num, value_bool)", "The value, as text.", { required: true, width: 40 }),
    C("unit", "UNIT", "text", "pmd.product_specification.unit", "Unit of a numeric value."),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source that supplied this value.", { required: true }),
    C("confidence_score", "CONFIDENCE_SCORE", "number", "pmd.product_specification.confidence", "Source-reported confidence 0-100, when supplied."),
    C("is_preferred", "IS_PREFERRED", "bool", "pmd.product_specification.is_preferred", "True for the value currently in force."),
    C("original_value", "ORIGINAL_VALUE", "text", "pmd.product_specification.original_value", "The value exactly as the source wrote it."),
    C("source_url", "SOURCE_URL", "text", "pmd.product_specification.source_url", "Where the source published it."),
    C("collected_at", "COLLECTED_AT", "timestamp", "pmd.product_specification.collected_at", "When it was collected (UTC)."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, sp.attribute_key, ad.attribute_label AS attribute_name, ad.attribute_group,
           COALESCE(sp.value_text, CASE WHEN sp.value_num IS NOT NULL THEN trim(trailing '.' FROM trim(trailing '0' FROM sp.value_num::text)) END,
                    CASE WHEN sp.value_bool IS NOT NULL THEN CASE WHEN sp.value_bool THEN 'Yes' ELSE 'No' END END) AS attribute_value,
           sp.unit, s.source_key AS source, sp.confidence AS confidence_score, sp.is_preferred, sp.original_value, sp.source_url, sp.collected_at
    FROM pmd.product_specification sp
    JOIN pmd.product_master pm USING (product_id)
    JOIN pmd.attribute_definition ad USING (attribute_key)
    JOIN pmd.source s USING (source_id)
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id, ad.sort_order, sp.attribute_key, s.source_key`,
};

/* ----------------------------------------------------------- PRODUCT_SOURCE */

const sources: SheetDef = {
  name: "PRODUCT_SOURCE",
  tableName: "tblProductSource",
  description: "One row per source listing: where each product was seen, how it was collected, and how it was tied to a master product.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Linked master product; blank while awaiting review.", { width: 20 }),
    C("source_name", "SOURCE_NAME", "text", "pmd.source.source_key", "Source the listing was collected from.", { required: true }),
    C("source_product_id", "SOURCE_PRODUCT_ID", "text", "pmd.product_source.source_product_id", "The source's own id (barcode, ASIN, FSN...).", { required: true }),
    C("source_product_url", "SOURCE_PRODUCT_URL", "text", "pmd.product_source.source_url", "Public page for the listing (referenced, not fetched)."),
    C("source_category", "SOURCE_CATEGORY", "text", "pmd.product_source.source_category", "The source's own category text."),
    C("source_product_name", "SOURCE_PRODUCT_NAME", "text", "pmd.product_source.source_product_name", "Name exactly as the source titled it.", { width: 40 }),
    C("source_brand", "SOURCE_BRAND", "text", "pmd.product_source.source_brand", "Brand exactly as the source wrote it."),
    C("source_mrp", "SOURCE_MRP", "money", "pmd.product_source.source_mrp_minor", "MRP the source showed."),
    C("source_price", "SOURCE_PRICE", "money", "pmd.product_source.source_price_minor", "Price the source showed."),
    C("source_rating", "SOURCE_RATING", "number", "pmd.product_source.source_rating", "Average customer rating the source showed."),
    C("source_review_count", "SOURCE_REVIEW_COUNT", "int", "pmd.product_source.source_review_count", "Number of customer reviews the source showed."),
    C("source_availability", "SOURCE_AVAILABILITY", "text", "pmd.product_source.source_availability", "Availability text the source showed."),
    C("first_seen_date", "FIRST_SEEN_DATE", "date", "pmd.product_source.first_seen_date", "First time collected."),
    C("last_seen_date", "LAST_SEEN_DATE", "date", "pmd.product_source.last_seen_date", "Most recent time seen."),
    C("data_collection_date", "DATA_COLLECTION_DATE", "date", "pmd.product_source.data_collection_date", "Date of the latest collection."),
    C("data_collection_method", "DATA_COLLECTION_METHOD", "text", "pmd.product_source.data_collection_method", "How it was collected (OPEN_DATASET_CSV, OFFICIAL_API_JSON, LICENSED_FEED_CSV...).", { required: true }),
    C("data_confidence", "DATA_CONFIDENCE", "number", "pmd.product_source.data_confidence", "Confidence 0-100 (source-reported completeness, else source reliability)."),
    C("match_status", "MATCH_STATUS", "text", "pmd.product_source.match_status", "Result of comparing to existing masters.", { allowed: MATCH_STATUS }),
    C("match_score", "MATCH_SCORE", "number", "pmd.product_source.match_score", "Match score 0-100 against the best candidate."),
    C("match_rule", "MATCH_RULE", "text", "pmd.product_source.match_rule", "Which rule decided (L1_GTIN_BRAND, L3_STRUCTURED, ...)."),
    C("resolution", "RESOLUTION", "text", "pmd.product_source.resolution", "LINKED_EXISTING / CREATED_NEW / PENDING_REVIEW / MANUAL_LINK.", { allowed: ["LINKED_EXISTING", "CREATED_NEW", "PENDING_REVIEW", "MANUAL_LINK"] }),
  ],
  query: (s) => `
    SELECT pm.master_product_id, src.source_key AS source_name, ps.source_product_id, ps.source_url AS source_product_url, ps.source_category,
           ps.source_product_name, ps.source_brand, ps.source_mrp_minor AS source_mrp, ps.source_price_minor AS source_price, ps.source_rating,
           ps.source_review_count, ps.source_availability, ps.first_seen_date, ps.last_seen_date, ps.data_collection_date, ps.data_collection_method,
           ps.data_confidence, ps.match_status, ps.match_score, ps.match_rule, ps.resolution
    FROM pmd.product_source ps
    JOIN pmd.source src USING (source_id)
    LEFT JOIN pmd.product_master pm ON pm.product_id = ps.product_id
    WHERE (ps.product_id IS NULL AND ${s.fromProductId == null ? "true" : "false"}) OR (pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)})
    ORDER BY ps.product_id NULLS LAST, src.source_key, ps.source_product_id`,
};

/* ----------------------------------------------------------- PRODUCT_SELLER */

const sellers: SheetDef = {
  name: "PRODUCT_SELLER",
  tableName: "tblProductSeller",
  description: "One row per seller offer (current state). The same TV sold by five sellers is one master product and five rows here. Price history is in PRODUCT_PRICE_HISTORY.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Product being offered.", { required: true, width: 20 }),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Marketplace / feed the offer was seen on.", { required: true }),
    C("source_product_id", "SOURCE_PRODUCT_ID", "text", "pmd.product_offer.source_product_id", "The source listing id."),
    C("seller_id", "SELLER_ID", "text", "pmd.product_offer.seller_id", "Seller id in the source."),
    C("seller_name", "SELLER_NAME", "text", "pmd.product_offer.seller_name", "Name of the seller making the offer.", { width: 30 }),
    C("seller_location", "SELLER_LOCATION", "text", "pmd.product_offer.seller_location", "Seller location."),
    C("seller_rating", "SELLER_RATING", "number", "pmd.product_offer.seller_rating", "Seller rating (0-5)."),
    C("price", "PRICE", "money", "pmd.product_offer.price_minor", "Selling price (stored as integer minor units, shown in rupees)."),
    C("mrp", "MRP", "money", "pmd.product_offer.mrp_minor", "MRP shown by this seller."),
    C("discount", "DISCOUNT", "money", "pmd.product_offer.discount_minor", "MRP minus price."),
    C("discount_percentage", "DISCOUNT_PERCENTAGE", "percent", "pmd.product_offer.discount_pct", "Discount as a percentage of MRP."),
    C("currency", "CURRENCY", "text", "pmd.product_offer.currency", "ISO currency code of the amounts."),
    C("tax_inclusive", "TAX_INCLUSIVE", "bool", "pmd.product_offer.tax_inclusive", "Whether the price includes tax."),
    C("stock_status", "STOCK_STATUS", "text", "pmd.product_offer.stock_status", "Stock status. UNKNOWN when the source does not say.", { allowed: STOCK }),
    C("delivery_information", "DELIVERY_INFORMATION", "text", "pmd.product_offer.delivery_information", "Delivery information."),
    C("source_url", "SOURCE_URL", "text", "pmd.product_offer.source_url", "Offer / listing page."),
    C("collection_date", "COLLECTION_DATE", "date", "pmd.product_offer.collection_date", "Date of the latest observation."),
    C("collection_timestamp", "COLLECTION_TIMESTAMP", "timestamp", "pmd.product_offer.collected_at", "Timestamp of the latest observation (UTC)."),
    C("is_current", "IS_CURRENT", "bool", "pmd.product_offer.is_current", "False when the source stopped listing the offer."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, src.source_key AS source, o.source_product_id, o.seller_id, o.seller_name, o.seller_location, o.seller_rating,
           o.price_minor AS price, o.mrp_minor AS mrp, o.discount_minor AS discount, o.discount_pct AS discount_percentage, o.currency,
           o.tax_inclusive, o.stock_status, o.delivery_information, o.source_url, o.collection_date, o.collected_at AS collection_timestamp, o.is_current
    FROM pmd.product_offer o
    JOIN pmd.product_master pm ON pm.product_id = o.product_id
    JOIN pmd.source src ON src.source_id = o.source_id
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id, src.source_key, o.seller_key`,
};

/* -------------------------------------------------------- PRODUCT_PRICE_HISTORY */

const priceHistory: SheetDef = {
  name: "PRODUCT_PRICE_HISTORY",
  tableName: "tblProductPriceHistory",
  description: "Append-only price observations: one row on first sighting and on every change of price, MRP or stock. Supports lowest / highest / average price and seller comparison.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Product the price observation belongs to.", { required: true, width: 20 }),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source that reported the price.", { required: true }),
    C("seller", "SELLER", "text", "pmd.price_history.seller_name", "Seller the price was observed at.", { width: 30 }),
    C("mrp", "MRP", "money", "pmd.price_history.mrp_minor", "MRP at the time."),
    C("selling_price", "SELLING_PRICE", "money", "pmd.price_history.selling_price_minor", "Selling price at the time.", { required: true }),
    C("discount", "DISCOUNT", "money", "pmd.price_history.discount_minor", "MRP minus price at the time."),
    C("currency", "CURRENCY", "text", "pmd.price_history.currency", "ISO currency code of the amounts."),
    C("stock_status", "STOCK_STATUS", "text", "pmd.price_history.stock_status", "Stock status at the time.", { allowed: STOCK }),
    C("change_reason", "CHANGE_REASON", "text", "pmd.price_history.change_reason", "FIRST_SEEN / PRICE_CHANGED / MRP_CHANGED / STOCK_CHANGED / PRICE_AND_STOCK_CHANGED."),
    C("collection_date", "COLLECTION_DATE", "date", "pmd.price_history.collection_date", "Observation date."),
    C("collection_timestamp", "COLLECTION_TIMESTAMP", "timestamp", "pmd.price_history.collected_at", "Observation timestamp (UTC)."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, src.source_key AS source, h.seller_name AS seller, h.mrp_minor AS mrp, h.selling_price_minor AS selling_price,
           h.discount_minor AS discount, h.currency, h.stock_status, h.change_reason, h.collection_date, h.collected_at AS collection_timestamp
    FROM pmd.price_history h
    JOIN pmd.product_master pm ON pm.product_id = h.product_id
    JOIN pmd.source src ON src.source_id = h.source_id
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id, h.offer_id, h.collected_at, h.price_history_id`,
};

/* --------------------------------------------------------------- BRAND / MFR */

const brands: SheetDef = {
  name: "BRAND_MASTER",
  tableName: "tblBrandMaster",
  description: "Normalised brands. \"Samsung\", \"SAMSUNG\" and \"Samsung India\" are one brand; every original spelling is preserved in ALIASES.",
  freezeColumns: 2,
  columns: [
    C("brand_id", "BRAND_ID", "text", "pmd.brand.brand_code", "Brand id (GKS-BRND-#########).", { required: true, width: 20 }),
    C("brand_name", "BRAND_NAME", "text", "pmd.brand.brand_name", "Canonical brand name.", { required: true, width: 30 }),
    C("legal_company_name", "LEGAL_COMPANY_NAME", "text", "pmd.brand.legal_company_name", "Legal company name, when known."),
    C("manufacturer", "MANUFACTURER", "text", "pmd.manufacturer.manufacturer_name", "Owning manufacturer, when known."),
    C("country", "COUNTRY", "text", "pmd.brand.country", "Brand country, when a source states it."),
    C("website", "WEBSITE", "text", "pmd.brand.website", "Official brand website, when known."),
    C("category", "CATEGORY", "text", "pmd.category.name", "Primary category, when known."),
    C("brand_status", "BRAND_STATUS", "text", "pmd.brand.brand_status", "ACTIVE / INACTIVE / UNVERIFIED.", { allowed: ["ACTIVE", "INACTIVE", "UNVERIFIED"] }),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source that first reported the brand."),
    C("verification_status", "VERIFICATION_STATUS", "text", "pmd.brand.verification_status", "UNVERIFIED / VERIFIED / DISPUTED.", { allowed: VERIFY }),
    C("aliases", "ALIASES", "list", "pmd.brand_alias.alias_original", "Every spelling seen in sources (originals preserved)."),
    C("product_count", "PRODUCT_COUNT", "int", "count(pmd.product_master)", "ACTIVE products. DERIVED.", { derived: true }),
  ],
  query: () => `
    SELECT b.brand_code AS brand_id, b.brand_name, b.legal_company_name, m.manufacturer_name AS manufacturer, b.country, b.website, c.name AS category,
           b.brand_status, s.source_key AS source, b.verification_status,
           ARRAY(SELECT alias_original FROM pmd.brand_alias a WHERE a.brand_id = b.brand_id ORDER BY alias_original) AS aliases,
           (SELECT count(*)::int FROM pmd.product_master p WHERE p.brand_id = b.brand_id AND p.record_status = 'ACTIVE') AS product_count
    FROM pmd.brand b
    LEFT JOIN pmd.manufacturer m ON m.manufacturer_id = b.manufacturer_id
    LEFT JOIN pmd.category c ON c.category_id = b.primary_category_id
    LEFT JOIN pmd.source s ON s.source_id = b.source_id
    ORDER BY b.brand_id`,
};

const manufacturers: SheetDef = {
  name: "MANUFACTURER_MASTER",
  tableName: "tblManufacturerMaster",
  description: "Manufacturers / brand owners. Nothing is invented: a blank means no source has supplied it.",
  freezeColumns: 2,
  columns: [
    C("manufacturer_id", "MANUFACTURER_ID", "text", "pmd.manufacturer.manufacturer_code", "Manufacturer id (GKS-MFR-#########).", { required: true, width: 20 }),
    C("manufacturer_name", "MANUFACTURER_NAME", "text", "pmd.manufacturer.manufacturer_name", "Canonical name.", { required: true, width: 34 }),
    C("legal_name", "LEGAL_NAME", "text", "pmd.manufacturer.legal_name", "Registered legal name."),
    C("address", "ADDRESS", "text", "pmd.manufacturer.address", "Address (only where publicly published)."),
    C("country", "COUNTRY", "text", "pmd.manufacturer.country", "Manufacturer country, when a source states it."),
    C("gstin", "GSTIN", "text", "pmd.manufacturer.gstin", "GSTIN, structure-validated. Registration status is not verified."),
    C("website", "WEBSITE", "text", "pmd.manufacturer.website", "Official manufacturer website, when known."),
    C("contact_information", "CONTACT_INFORMATION", "text", "pmd.manufacturer.contact_information", "Public business contact only."),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source that first reported it."),
    C("verification_status", "VERIFICATION_STATUS", "text", "pmd.manufacturer.verification_status", "UNVERIFIED / VERIFIED / DISPUTED.", { allowed: VERIFY }),
    C("aliases", "ALIASES", "list", "pmd.manufacturer_alias.alias_original", "Every spelling seen in sources."),
    C("brand_count", "BRAND_COUNT", "int", "count(pmd.brand)", "Brands owned. DERIVED.", { derived: true }),
  ],
  query: () => `
    SELECT m.manufacturer_code AS manufacturer_id, m.manufacturer_name, m.legal_name, m.address, m.country, m.gstin, m.website, m.contact_information,
           s.source_key AS source, m.verification_status,
           ARRAY(SELECT alias_original FROM pmd.manufacturer_alias a WHERE a.manufacturer_id = m.manufacturer_id ORDER BY alias_original) AS aliases,
           (SELECT count(*)::int FROM pmd.brand b WHERE b.manufacturer_id = m.manufacturer_id) AS brand_count
    FROM pmd.manufacturer m LEFT JOIN pmd.source s ON s.source_id = m.source_id
    ORDER BY m.manufacturer_id`,
};

/* ------------------------------------------------------- CATEGORY / MAPPING */

const categories: SheetDef = {
  name: "CATEGORY_MASTER",
  tableName: "tblCategoryMaster",
  description: "The Gokesari standard taxonomy, five levels deep.",
  freezeColumns: 2,
  columns: [
    C("standard_category_id", "STANDARD_CATEGORY_ID", "int", "pmd.category.category_id", "Standard_Category_ID.", { required: true }),
    C("category_code", "CATEGORY_CODE", "text", "pmd.category.category_code", "Stable slug path.", { required: true, width: 46 }),
    C("level", "LEVEL", "int", "pmd.category.level", "Depth in the taxonomy: 1 (top) to 5.", { required: true }),
    C("category_level_1", "CATEGORY_LEVEL_1", "text", "pmd.category.path_names[1]", "Category, level 1."),
    C("category_level_2", "CATEGORY_LEVEL_2", "text", "pmd.category.path_names[2]", "Category, level 2."),
    C("category_level_3", "CATEGORY_LEVEL_3", "text", "pmd.category.path_names[3]", "Category, level 3."),
    C("category_level_4", "CATEGORY_LEVEL_4", "text", "pmd.category.path_names[4]", "Category, level 4."),
    C("category_level_5", "CATEGORY_LEVEL_5", "text", "pmd.category.path_names[5]", "Category, level 5."),
    C("parent_category_id", "PARENT_CATEGORY_ID", "int", "pmd.category.parent_id", "STANDARD_CATEGORY_ID of the parent node."),
    C("gokesari_department", "GOKESARI_DEPARTMENT", "text", "pmd.category.gokesari_department", "Closest GoKesari shop type (guides promotion into the catalogue)."),
    C("product_count", "PRODUCT_COUNT", "int", "count(pmd.product_master)", "ACTIVE products at exactly this node. DERIVED.", { derived: true }),
  ],
  query: () => `
    SELECT c.category_id AS standard_category_id, c.category_code, c.level, c.path_names[1] AS category_level_1, c.path_names[2] AS category_level_2,
           c.path_names[3] AS category_level_3, c.path_names[4] AS category_level_4, c.path_names[5] AS category_level_5,
           c.parent_id AS parent_category_id, c.gokesari_department,
           (SELECT count(*)::int FROM pmd.product_master p WHERE p.category_id = c.category_id AND p.record_status = 'ACTIVE') AS product_count
    FROM pmd.category c ORDER BY c.sort_order`,
};

const categoryMapping: SheetDef = {
  name: "CATEGORY_MAPPING",
  tableName: "tblCategoryMapping",
  description: "SOURCE_CATEGORY -> STANDARD_CATEGORY. Manual mappings (MAPPED_BY <> SYSTEM) override the shipped rules.",
  freezeColumns: 2,
  columns: [
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source whose category is being mapped.", { required: true }),
    C("source_category", "SOURCE_CATEGORY", "text", "pmd.category_mapping.source_category", "Normalised source category (lookup key).", { required: true, width: 34 }),
    C("source_category_original", "SOURCE_CATEGORY_ORIGINAL", "text", "pmd.category_mapping.source_category_original", "As the source wrote it.", { width: 34 }),
    C("standard_category_id", "STANDARD_CATEGORY_ID", "int", "pmd.category_mapping.standard_category_id", "Standard category the source category maps to.", { required: true }),
    C("standard_category_path", "STANDARD_CATEGORY_PATH", "text", "array_to_string(pmd.category.path_names, ' > ')", "Target node, spelled out.", { width: 50 }),
    C("match_type", "MATCH_TYPE", "text", "pmd.category_mapping.match_type", "EXACT / PREFIX / KEYWORD / MANUAL."),
    C("confidence", "CONFIDENCE", "number", "pmd.category_mapping.confidence", "Confidence 0-100."),
    C("mapped_by", "MAPPED_BY", "text", "pmd.category_mapping.mapped_by", "SYSTEM or the steward who set it."),
  ],
  query: () => `
    SELECT s.source_key AS source, cm.source_category, cm.source_category_original, cm.standard_category_id,
           array_to_string(c.path_names, ' > ') AS standard_category_path, cm.match_type, cm.confidence, cm.mapped_by
    FROM pmd.category_mapping cm JOIN pmd.source s USING (source_id) JOIN pmd.category c ON c.category_id = cm.standard_category_id
    WHERE cm.is_active ORDER BY s.source_key, cm.source_category`,
};

/* ----------------------------------------------------------------- CONFLICTS */

const conflicts: SheetDef = {
  name: "PRODUCT_ATTRIBUTE_CONFLICT",
  tableName: "tblProductAttributeConflict",
  description: "Where sources disagree about a fact. Nothing is silently overwritten: manufacturer/brand data is preferred for technical specifications and the rule is recorded; equally authoritative sources stay OPEN for a person.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Product the disagreement is about.", { required: true, width: 20 }),
    C("attribute_name", "ATTRIBUTE_NAME", "text", "pmd.attribute_definition.attribute_label", "Attribute in dispute.", { required: true, width: 28 }),
    C("value_1", "VALUE_1", "text", "pmd.product_attribute_conflict.value_1", "The preferred (winning) source's value.", { required: true }),
    C("source_1", "SOURCE_1", "text", "pmd.product_attribute_conflict.source_1", "Source of VALUE_1.", { required: true }),
    C("value_2", "VALUE_2", "text", "pmd.product_attribute_conflict.value_2", "The disagreeing value.", { required: true }),
    C("source_2", "SOURCE_2", "text", "pmd.product_attribute_conflict.source_2", "Source of VALUE_2.", { required: true }),
    C("conflict_status", "CONFLICT_STATUS", "text", "pmd.product_attribute_conflict.conflict_status", "OPEN / AUTO_RESOLVED / MANUALLY_RESOLVED / IGNORED.", { required: true, allowed: CONFLICT_STATUS }),
    C("resolution", "RESOLUTION", "text", "pmd.product_attribute_conflict.resolution", "How it was resolved.", { width: 40 }),
    C("resolution_source", "RESOLUTION_SOURCE", "text", "pmd.product_attribute_conflict.resolution_source", "RULE:SPEC_PRECEDENCE, RULE:CONVERGED, MERGE, or a steward."),
    C("resolution_date", "RESOLUTION_DATE", "timestamp", "pmd.product_attribute_conflict.resolution_date", "When it was resolved (UTC)."),
    C("detected_at", "DETECTED_AT", "timestamp", "pmd.product_attribute_conflict.detected_at", "When it was detected (UTC)."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, COALESCE(ad.attribute_label, c.attribute_key) AS attribute_name, c.value_1, c.source_1, c.value_2, c.source_2,
           c.conflict_status, c.resolution, c.resolution_source, c.resolution_date, c.detected_at
    FROM pmd.product_attribute_conflict c
    JOIN pmd.product_master pm USING (product_id)
    LEFT JOIN pmd.attribute_definition ad ON ad.attribute_key = c.attribute_key
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id, c.attribute_key, c.conflict_id`,
};

/* ------------------------------------------------------------- DATA_QUALITY */

const quality: SheetDef = {
  name: "DATA_QUALITY",
  tableName: "tblDataQuality",
  description: "Per-product data quality: the score, each component, and exactly which fields are missing. Missing data is blank / NOT_AVAILABLE, never zero.",
  freezeColumns: 2,
  columns: [
    C("master_product_id", "MASTER_PRODUCT_ID", "text", "pmd.product_master.master_product_id", "Product being scored.", { required: true, width: 20 }),
    C("product_name", "PRODUCT_NAME", "text", "pmd.product_master.product_name", "Product name, for readability.", { width: 40 }),
    C("data_quality_score", "DATA_QUALITY_SCORE", "number", "pmd.product_master.data_quality_score", "0-100 composite.", { required: true }),
    C("identifier_score", "IDENTIFIER_SCORE", "number", "quality_components.identifier", "Identifier strength (valid GTIN = 100)."),
    C("source_reliability_score", "SOURCE_RELIABILITY_SCORE", "number", "quality_components.sourceReliability", "Best source's reliability."),
    C("corroboration_score", "CORROBORATION_SCORE", "number", "quality_components.corroboration", "Number of independent sources."),
    C("completeness_score", "COMPLETENESS_SCORE", "number", "quality_components.completeness", "Share of expected fields present for this kind of product."),
    C("match_confidence_score", "MATCH_CONFIDENCE_SCORE", "number", "quality_components.matchConfidence", "Confidence the linked records are one product. Blank = not recorded."),
    C("recency_score", "RECENCY_SCORE", "number", "quality_components.recency", "How recently a source saw it."),
    C("missing_fields", "MISSING_FIELDS", "list", "quality_components.missingFields", "Fields expected but absent.", { width: 44 }),
    C("source_count", "SOURCE_COUNT", "int", "count(pmd.product_source)", "Linked sources. DERIVED.", { derived: true }),
    C("has_gtin", "HAS_GTIN", "bool", "pmd.product_master.gtin is not null", "Valid GTIN present. DERIVED.", { derived: true }),
    C("has_brand", "HAS_BRAND", "bool", "pmd.product_master.brand_id is not null", "Brand present. DERIVED.", { derived: true }),
    C("has_manufacturer", "HAS_MANUFACTURER", "bool", "pmd.product_master.manufacturer_id is not null", "Manufacturer present. DERIVED.", { derived: true }),
    C("has_category", "HAS_CATEGORY", "bool", "pmd.product_master.category_id is not null", "Standard category present. DERIVED.", { derived: true }),
    C("has_mrp_observation", "HAS_MRP_OBSERVATION", "bool", "any offer/source with an MRP", "An MRP has been observed somewhere. DERIVED.", { derived: true }),
    C("has_gst", "HAS_GST", "bool", "pmd.product_master.gst_rate_bp is not null", "GST rate present. DERIVED.", { derived: true }),
    C("has_hsn", "HAS_HSN", "bool", "pmd.product_master.hsn_code is not null", "HSN present. DERIVED.", { derived: true }),
    C("open_conflicts", "OPEN_CONFLICTS", "int", "count(pmd.product_attribute_conflict) OPEN", "Unresolved conflicts. DERIVED.", { derived: true }),
    C("pending_review_items", "PENDING_REVIEW_ITEMS", "int", "count(pmd.match_candidate) PENDING", "Possible-duplicate items awaiting a person. DERIVED.", { derived: true }),
    C("quality_computed_at", "QUALITY_COMPUTED_AT", "timestamp", "pmd.product_master.quality_computed_at", "When the score was computed (UTC)."),
  ],
  query: (s) => `
    SELECT pm.master_product_id, pm.product_name, pm.data_quality_score,
           (pm.quality_components #>> '{components,identifier,score}')::numeric AS identifier_score,
           (pm.quality_components #>> '{components,sourceReliability,score}')::numeric AS source_reliability_score,
           (pm.quality_components #>> '{components,corroboration,score}')::numeric AS corroboration_score,
           (pm.quality_components #>> '{components,completeness,score}')::numeric AS completeness_score,
           (pm.quality_components #>> '{components,matchConfidence,score}')::numeric AS match_confidence_score,
           (pm.quality_components #>> '{components,recency,score}')::numeric AS recency_score,
           ARRAY(SELECT jsonb_array_elements_text(COALESCE(pm.quality_components -> 'missingFields', '[]'::jsonb))) AS missing_fields,
           (SELECT count(*)::int FROM pmd.product_source x WHERE x.product_id = pm.product_id) AS source_count,
           pm.gtin IS NOT NULL AS has_gtin, pm.brand_id IS NOT NULL AS has_brand, pm.manufacturer_id IS NOT NULL AS has_manufacturer,
           pm.category_id IS NOT NULL AS has_category,
           (EXISTS (SELECT 1 FROM pmd.product_offer o WHERE o.product_id = pm.product_id AND o.mrp_minor IS NOT NULL)
            OR EXISTS (SELECT 1 FROM pmd.product_source x WHERE x.product_id = pm.product_id AND x.source_mrp_minor IS NOT NULL)) AS has_mrp_observation,
           pm.gst_rate_bp IS NOT NULL AS has_gst, pm.hsn_code IS NOT NULL AS has_hsn,
           (SELECT count(*)::int FROM pmd.product_attribute_conflict x WHERE x.product_id = pm.product_id AND x.conflict_status = 'OPEN') AS open_conflicts,
           (SELECT count(*)::int FROM pmd.match_candidate mc JOIN pmd.product_source ps USING (product_source_id) WHERE ps.product_id = pm.product_id AND mc.review_status = 'PENDING') AS pending_review_items,
           pm.quality_computed_at
    FROM pmd.product_master pm
    WHERE pm.record_status = 'ACTIVE' AND ${range("pm.product_id", s)}
    ORDER BY pm.product_id`,
};

/* ------------------------------------------------------------- IMPORT_ERRORS */

const importErrors: SheetDef = {
  name: "IMPORT_ERRORS",
  tableName: "tblImportErrors",
  description: "Everything that could not be used or deserved a second look during collection: unusable records (ERROR) and repaired or suspicious values (WARNING). The run continues past each one.",
  freezeColumns: 1,
  columns: [
    C("run_id", "RUN_ID", "int", "pmd.import_error.run_id", "Ingestion run.", { required: true }),
    C("source", "SOURCE", "text", "pmd.source.source_key", "Source of the record that failed or was repaired.", { required: true }),
    C("source_record_id", "SOURCE_RECORD_ID", "text", "pmd.import_error.source_record_id", "The source's own id for the record."),
    C("stage", "STAGE", "text", "pmd.import_error.stage", "Pipeline stage: EXTRACT / PARSE / NORMALIZE / MATCH / VALIDATE / LOAD.", { required: true }),
    C("severity", "SEVERITY", "text", "pmd.import_error.severity", "ERROR (record not loaded) or WARNING (loaded, value repaired or flagged).", { required: true, allowed: ["ERROR", "WARNING"] }),
    C("error_code", "ERROR_CODE", "text", "pmd.import_error.error_code", "Machine-readable error code.", { required: true, width: 28 }),
    C("message", "MESSAGE", "text", "pmd.import_error.message", "Human-readable explanation of the problem.", { required: true, width: 60 }),
    C("created_at", "CREATED_AT", "timestamp", "pmd.import_error.created_at", "When it was logged (UTC)."),
    C("raw_excerpt", "RAW_EXCERPT", "text", "pmd.import_error.raw_excerpt", "Start of the offending value or record (personal data already stripped).", { width: 50 }),
  ],
  query: (s) => `
    SELECT e.run_id, src.source_key AS source, e.source_record_id, e.stage, e.severity, e.error_code, e.message, e.created_at, e.raw_excerpt ->> 'excerpt' AS raw_excerpt
    FROM pmd.import_error e JOIN pmd.source src USING (source_id)
    WHERE ${s.fromProductId == null ? "true" : "false"}
    ORDER BY e.error_id`,
};

/**
 * The 13 sheets of the brief, in order. DATA_DICTIONARY (11) is generated from these
 * definitions, so it is inserted by the builder rather than queried.
 */
export const DATA_SHEETS: readonly SheetDef[] = [
  productMaster, specifications, sources, sellers, priceHistory, brands, manufacturers, categories, categoryMapping, conflicts, quality, importErrors,
];

/** Order required by the brief; DATA_DICTIONARY sits at position 11. */
export const SHEET_ORDER = [
  "PRODUCT_MASTER", "PRODUCT_SPECIFICATIONS", "PRODUCT_SOURCE", "PRODUCT_SELLER", "PRODUCT_PRICE_HISTORY", "BRAND_MASTER",
  "MANUFACTURER_MASTER", "CATEGORY_MASTER", "CATEGORY_MAPPING", "PRODUCT_ATTRIBUTE_CONFLICT", "DATA_DICTIONARY", "DATA_QUALITY", "IMPORT_ERRORS",
] as const;
