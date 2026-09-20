-- ============================================================================
-- 0015  Product Master Data Platform  (schema `pmd`)
--
-- Hand-written (like 0001 / 0003): partitioned tables, trigram indexes and
-- generated identifiers cannot be expressed in Drizzle's schema DSL.
--
-- ADDITIVE ONLY. Creates a new schema and touches no existing table. The single
-- coupling to the live marketplace is pmd.catalogue_link -> public.products.
--
--   pmd.product_master        the universal, multi-source product record
--   public.products           GOKESARI_PRODUCT_CATALOG (unchanged, operational)
--   public.shop_products      SHOP_PRODUCT_CATALOG     (unchanged, per-shop price/stock)
--
-- Conventions
--   * Money is integer minor units (paise for INR) + an explicit currency column.
--   * Every score (match, quality, confidence) is numeric 0-100.
--   * Missing data is NULL, never 0 / '' (Excel export renders NOT_AVAILABLE).
--   * Enumerations are text + CHECK (adding a value is a cheap ALTER, not an
--     enum rewrite).
--   * History is append-only; nothing here is ever deleted by the pipeline.
--
-- Rollback: scripts/pmd/rollback-0015.sql
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS pmd;
--> statement-breakpoint

CREATE FUNCTION pmd.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. SOURCE REGISTRY  (the SOURCE_ADAPTER configuration)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.source (
  source_id             smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key            text     NOT NULL UNIQUE,
  source_name           text     NOT NULL,
  source_kind           text     NOT NULL CHECK (source_kind IN
    ('MARKETPLACE','BRAND_MANUFACTURER','GOVERNMENT','OPEN_DATA','LICENSED_FEED','GS1','DISTRIBUTOR','INTERNAL')),
  access_method         text     NOT NULL CHECK (access_method IN
    ('OFFICIAL_API','LICENSED_FEED','OPEN_DATASET','MANUFACTURER_FEED','PERMITTED_PUBLIC_PAGE','INTERNAL_DB','MANUAL_UPLOAD','NONE')),
  -- Only ACTIVE + enabled sources can ingest. BLOCKED_* rows exist so the gap is visible, not hidden.
  status                text     NOT NULL DEFAULT 'PLANNED' CHECK (status IN
    ('ACTIVE','PLANNED','BLOCKED_NEEDS_AGREEMENT','BLOCKED_TECHNICAL','DISABLED')),
  enabled               boolean  NOT NULL DEFAULT false,
  reliability           smallint NOT NULL DEFAULT 50 CHECK (reliability BETWEEN 0 AND 100),
  -- Lower wins when two sources disagree on a technical specification.
  spec_precedence       smallint NOT NULL DEFAULT 50,
  legal_basis           text     NOT NULL,
  license_name          text,
  terms_url             text,
  robots_policy         text,
  api_endpoint          text,
  -- NAME of the environment variable holding credentials. Never the secret itself.
  auth_env_var          text,
  collection_frequency  text,
  rate_limit_per_min    integer,
  parser_key            text,
  field_mapping         jsonb    NOT NULL DEFAULT '{}'::jsonb,
  retry_max             smallint NOT NULL DEFAULT 3,
  last_success_at       timestamptz,
  last_run_products     integer,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_enabled_requires_active CHECK (NOT enabled OR status = 'ACTIVE')
);
--> statement-breakpoint
CREATE TRIGGER source_touch BEFORE UPDATE ON pmd.source FOR EACH ROW EXECUTE FUNCTION pmd.touch_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. COLLECTION LOG, IMPORT ERRORS, RAW STAGING
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.ingestion_run (
  run_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id         smallint NOT NULL REFERENCES pmd.source (source_id),
  run_mode          text NOT NULL CHECK (run_mode IN ('PILOT','INITIAL_FULL','INCREMENTAL','IMPORT','BACKFILL')),
  status            text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  triggered_by      text NOT NULL DEFAULT 'system',
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  records_read      integer NOT NULL DEFAULT 0,
  records_staged    integer NOT NULL DEFAULT 0,
  records_unchanged integer NOT NULL DEFAULT 0,
  products_created  integer NOT NULL DEFAULT 0,
  products_linked   integer NOT NULL DEFAULT 0,
  products_updated  integer NOT NULL DEFAULT 0,
  offers_upserted   integer NOT NULL DEFAULT 0,
  price_changes     integer NOT NULL DEFAULT 0,
  review_queued     integer NOT NULL DEFAULT 0,
  conflicts_opened  integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,
  error_summary     text
);
--> statement-breakpoint
CREATE INDEX ingestion_run_source_idx ON pmd.ingestion_run (source_id, started_at DESC);
--> statement-breakpoint

CREATE TABLE pmd.import_error (
  error_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            bigint REFERENCES pmd.ingestion_run (run_id) ON DELETE CASCADE,
  source_id         smallint REFERENCES pmd.source (source_id),
  source_record_id  text,
  stage             text NOT NULL CHECK (stage IN ('EXTRACT','PARSE','NORMALIZE','MATCH','VALIDATE','LOAD')),
  severity          text NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR','WARNING')),
  error_code        text NOT NULL,
  message           text NOT NULL,
  raw_excerpt       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX import_error_run_idx ON pmd.import_error (run_id);
--> statement-breakpoint

-- Raw payload of every *changed* source record, kept for traceability and replay.
CREATE TABLE pmd.raw_record (
  raw_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            bigint REFERENCES pmd.ingestion_run (run_id) ON DELETE SET NULL,
  source_id         smallint NOT NULL REFERENCES pmd.source (source_id),
  source_product_id text NOT NULL,
  content_hash      text NOT NULL,
  payload           jsonb NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_product_id, content_hash)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. TAXONOMY  (CATEGORY_MASTER, CATEGORY_MAPPING)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.category (
  category_id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- Standard_Category_ID
  category_code       text     NOT NULL UNIQUE,                            -- slug path: grocery/staples/rice
  parent_id           integer  REFERENCES pmd.category (category_id),
  level               smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  name                text     NOT NULL,
  slug                text     NOT NULL,
  path_names          text[]   NOT NULL,
  path_ids            integer[] NOT NULL,
  gokesari_department text,                                                 -- informational: SHOP_TYPE key
  description         text,
  sort_order          integer  NOT NULL DEFAULT 0,
  is_active           boolean  NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_level_matches_path CHECK (level = cardinality(path_names)),
  CONSTRAINT category_parent_level CHECK ((level = 1) = (parent_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX category_parent_idx ON pmd.category (parent_id);
--> statement-breakpoint
CREATE TRIGGER category_touch BEFORE UPDATE ON pmd.category FOR EACH ROW EXECUTE FUNCTION pmd.touch_updated_at();
--> statement-breakpoint

CREATE TABLE pmd.category_mapping (
  mapping_id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id                 smallint NOT NULL REFERENCES pmd.source (source_id),
  source_category           text     NOT NULL,            -- normalized lookup key
  source_category_original  text     NOT NULL,
  standard_category_id      integer  NOT NULL REFERENCES pmd.category (category_id),
  match_type                text     NOT NULL DEFAULT 'EXACT' CHECK (match_type IN ('EXACT','PREFIX','KEYWORD','MANUAL')),
  confidence                numeric(5,2) NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  mapped_by                 text     NOT NULL DEFAULT 'SYSTEM',
  is_active                 boolean  NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_category)
);
--> statement-breakpoint
CREATE INDEX category_mapping_std_idx ON pmd.category_mapping (standard_category_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. MANUFACTURER MASTER, BRAND MASTER  (+ aliases preserve every source spelling)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE pmd.manufacturer_seq;
--> statement-breakpoint
CREATE TABLE pmd.manufacturer (
  manufacturer_id     bigint PRIMARY KEY DEFAULT nextval('pmd.manufacturer_seq'),
  manufacturer_code   text NOT NULL UNIQUE
    GENERATED ALWAYS AS ('GKS-MFR-' || lpad(manufacturer_id::text, 9, '0')) STORED,
  manufacturer_name   text NOT NULL,
  manufacturer_key    text NOT NULL UNIQUE,
  legal_name          text,
  address             text,
  country             text,
  gstin               text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  website             text,
  contact_information text,
  source_id           smallint REFERENCES pmd.source (source_id),
  verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER manufacturer_touch BEFORE UPDATE ON pmd.manufacturer FOR EACH ROW EXECUTE FUNCTION pmd.touch_updated_at();
--> statement-breakpoint
CREATE TABLE pmd.manufacturer_alias (
  alias_key         text PRIMARY KEY,
  manufacturer_id   bigint NOT NULL REFERENCES pmd.manufacturer (manufacturer_id) ON DELETE CASCADE,
  alias_original    text NOT NULL,
  source_id         smallint REFERENCES pmd.source (source_id),
  first_seen_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX manufacturer_alias_mfr_idx ON pmd.manufacturer_alias (manufacturer_id);
--> statement-breakpoint

CREATE SEQUENCE pmd.brand_seq;
--> statement-breakpoint
CREATE TABLE pmd.brand (
  brand_id            bigint PRIMARY KEY DEFAULT nextval('pmd.brand_seq'),
  brand_code          text NOT NULL UNIQUE
    GENERATED ALWAYS AS ('GKS-BRND-' || lpad(brand_id::text, 9, '0')) STORED,
  brand_name          text NOT NULL,
  brand_key           text NOT NULL UNIQUE,
  legal_company_name  text,
  manufacturer_id     bigint REFERENCES pmd.manufacturer (manufacturer_id),
  country             text,
  website             text,
  primary_category_id integer REFERENCES pmd.category (category_id),
  brand_status        text NOT NULL DEFAULT 'ACTIVE' CHECK (brand_status IN ('ACTIVE','INACTIVE','UNVERIFIED')),
  source_id           smallint REFERENCES pmd.source (source_id),
  verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX brand_manufacturer_idx ON pmd.brand (manufacturer_id);
--> statement-breakpoint
CREATE INDEX brand_name_trgm_idx ON pmd.brand USING gin (brand_name gin_trgm_ops);
--> statement-breakpoint
CREATE TRIGGER brand_touch BEFORE UPDATE ON pmd.brand FOR EACH ROW EXECUTE FUNCTION pmd.touch_updated_at();
--> statement-breakpoint
-- "Samsung", "SAMSUNG", "Samsung India" -> one brand; each original spelling kept.
CREATE TABLE pmd.brand_alias (
  alias_key         text PRIMARY KEY,
  brand_id          bigint NOT NULL REFERENCES pmd.brand (brand_id) ON DELETE CASCADE,
  alias_original    text NOT NULL,
  source_id         smallint REFERENCES pmd.source (source_id),
  first_seen_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX brand_alias_brand_idx ON pmd.brand_alias (brand_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. PRODUCT FAMILY + PRODUCT MASTER
-- ---------------------------------------------------------------------------
-- A family groups the pack sizes / variants of one product line. Two members of a
-- family are DIFFERENT products (own master record, own GTIN) - the family only
-- records that they are related.
CREATE TABLE pmd.product_family (
  family_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id     bigint REFERENCES pmd.brand (brand_id),
  family_key   text NOT NULL,
  family_name  text NOT NULL,
  category_id  integer REFERENCES pmd.category (category_id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX product_family_uq ON pmd.product_family (COALESCE(brand_id, 0), family_key);
--> statement-breakpoint

CREATE SEQUENCE pmd.product_seq;
--> statement-breakpoint
CREATE TABLE pmd.product_master (
  product_id         bigint PRIMARY KEY DEFAULT nextval('pmd.product_seq'),
  master_product_id  text NOT NULL UNIQUE
    GENERATED ALWAYS AS ('GKS-PROD-' || lpad(product_id::text, 9, '0')) STORED,

  -- identification ---------------------------------------------------------
  product_family_id  bigint REFERENCES pmd.product_family (family_id),
  brand_id           bigint REFERENCES pmd.brand (brand_id),
  manufacturer_id    bigint REFERENCES pmd.manufacturer (manufacturer_id),
  gtin               text CHECK (gtin ~ '^[0-9]{14}$'),      -- canonical GTIN-14 (EAN-13 / UPC-A / GTIN-8 zero-padded)
  ean                text,                                    -- display forms derived from gtin
  upc                text,
  isbn               text,
  sku                text,
  mpn                text,
  model_number       text,
  product_code       text,

  -- description ------------------------------------------------------------
  product_name       text NOT NULL,
  normalized_name    text NOT NULL,                           -- name minus brand/pack/variant tokens, used to match
  search_text        text NOT NULL,                           -- brand + name + variant + model, used to search
  short_description  text,
  long_description   text,
  product_type       text,
  sub_type           text,
  variant_name       text,
  variant_code       text,
  key_features       jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_keywords    text[] NOT NULL DEFAULT '{}',

  -- classification ---------------------------------------------------------
  category_id        integer REFERENCES pmd.category (category_id),

  -- physical (canonical units: g, ml, mm, pcs; original text lives in specifications) ---
  net_weight_g       numeric(16,4) CHECK (net_weight_g IS NULL OR net_weight_g >= 0),
  gross_weight_g     numeric(16,4) CHECK (gross_weight_g IS NULL OR gross_weight_g >= 0),
  weight_unit        text NOT NULL DEFAULT 'g',
  length_mm          numeric(16,3) CHECK (length_mm IS NULL OR length_mm >= 0),
  width_mm           numeric(16,3) CHECK (width_mm IS NULL OR width_mm >= 0),
  height_mm          numeric(16,3) CHECK (height_mm IS NULL OR height_mm >= 0),
  dimension_unit     text NOT NULL DEFAULT 'mm',
  volume_ml          numeric(16,4) CHECK (volume_ml IS NULL OR volume_ml >= 0),
  volume_unit        text NOT NULL DEFAULT 'ml',
  net_quantity_value numeric(16,4) CHECK (net_quantity_value IS NULL OR net_quantity_value > 0),
  net_quantity_unit  text CHECK (net_quantity_unit IN ('g','ml','pcs','mm')),
  pack_size          text,
  pack_count         integer CHECK (pack_count IS NULL OR pack_count >= 1),
  unit_count         integer CHECK (unit_count IS NULL OR unit_count >= 1),
  material           text,
  color              text,
  size               text,
  shape              text,

  -- tax (NOT price: MRP / selling price are per-offer, per-date - see product_offer) ---
  gst_rate_bp        integer CHECK (gst_rate_bp IS NULL OR gst_rate_bp BETWEEN 0 AND 10000),
  hsn_code           text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  cess_bp            integer CHECK (cess_bp IS NULL OR cess_bp >= 0),
  other_taxes        jsonb,

  -- lifecycle ----------------------------------------------------------------
  product_status     text NOT NULL DEFAULT 'UNKNOWN' CHECK (product_status IN
    ('ACTIVE','OUT_OF_STOCK','DISCONTINUED','TEMPORARILY_UNAVAILABLE','UNKNOWN')),
  status_basis       text,
  status_updated_at  timestamptz,
  record_status      text NOT NULL DEFAULT 'ACTIVE' CHECK (record_status IN ('ACTIVE','MERGED','SUPPRESSED')),
  merged_into_product_id bigint REFERENCES pmd.product_master (product_id),

  -- provenance for master columns that are not in product_specification:
  -- {"product_name": <source_id>, "category_id": <source_id>, ...}
  field_sources      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- data quality / governance -------------------------------------------------
  data_quality_score numeric(5,2) CHECK (data_quality_score IS NULL OR data_quality_score BETWEEN 0 AND 100),
  quality_components jsonb,
  quality_computed_at timestamptz,
  match_confidence   numeric(5,2) CHECK (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 100),
  version            integer NOT NULL DEFAULT 1,
  created_run_id     bigint REFERENCES pmd.ingestion_run (run_id),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_master_merge_consistent CHECK ((record_status = 'MERGED') = (merged_into_product_id IS NOT NULL))
);
--> statement-breakpoint
-- One ACTIVE master per GTIN. Merged/suppressed rows keep their historic value.
CREATE UNIQUE INDEX product_master_gtin_uq ON pmd.product_master (gtin)
  WHERE gtin IS NOT NULL AND record_status = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX product_master_brand_cat_idx   ON pmd.product_master (brand_id, category_id);
--> statement-breakpoint
CREATE INDEX product_master_category_idx    ON pmd.product_master (category_id);
--> statement-breakpoint
CREATE INDEX product_master_family_idx      ON pmd.product_master (product_family_id);
--> statement-breakpoint
-- Same brand + identical core name = pack-size / variant siblings (family grouping).
CREATE INDEX product_master_brand_name_idx  ON pmd.product_master (brand_id, normalized_name) WHERE brand_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX product_master_mfr_idx         ON pmd.product_master (manufacturer_id);
--> statement-breakpoint
CREATE INDEX product_master_mpn_idx         ON pmd.product_master (brand_id, mpn) WHERE mpn IS NOT NULL;
--> statement-breakpoint
CREATE INDEX product_master_model_idx       ON pmd.product_master (brand_id, model_number) WHERE model_number IS NOT NULL;
--> statement-breakpoint
CREATE INDEX product_master_status_idx      ON pmd.product_master (product_status) WHERE record_status = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX product_master_quality_idx     ON pmd.product_master (data_quality_score) WHERE record_status = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX product_master_seen_idx        ON pmd.product_master (last_seen_at);
--> statement-breakpoint
-- Fuzzy candidate retrieval (blocking) and keyword search.
CREATE INDEX product_master_name_trgm_idx   ON pmd.product_master USING gin (normalized_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX product_master_search_trgm_idx ON pmd.product_master USING gin (search_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX product_master_search_fts_idx  ON pmd.product_master USING gin (to_tsvector('simple', search_text));
--> statement-breakpoint
-- No updated_at trigger on product_master: updated_at means "a business field changed" and is set by the
-- loader. A trigger would also fire for quality-score and status recomputes and make every refreshed
-- product look freshly updated on the dashboard.

-- ---------------------------------------------------------------------------
-- 6. IDENTIFIERS
-- ---------------------------------------------------------------------------
-- GTIN covers EAN-8/UPC-A/EAN-13/GTIN-14 (stored as GTIN-14). ISBN-13 is also a GTIN, so
-- a book carries both rows. MPN / MODEL / PRODUCT_CODE / SKU are NOT globally unique
-- (colour variants share a model), so only GTIN and ISBN are uniqueness-enforced.
CREATE TABLE pmd.product_identifier (
  identifier_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         bigint NOT NULL REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  id_type            text NOT NULL CHECK (id_type IN
    ('GTIN','ISBN','MPN','MODEL','PRODUCT_CODE','SKU','SOURCE_CODE','INTERNAL_BARCODE')),
  id_value           text NOT NULL,
  id_value_original  text NOT NULL,
  id_format          text,                               -- GTIN-8 / GTIN-12 / GTIN-13 / GTIN-14 / ISBN-10 / ISBN-13
  scope_brand_id     bigint REFERENCES pmd.brand (brand_id),
  is_primary         boolean NOT NULL DEFAULT false,
  check_digit_valid  boolean,
  source_id          smallint REFERENCES pmd.source (source_id),
  first_seen_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX product_identifier_global_uq ON pmd.product_identifier (id_type, id_value)
  WHERE id_type IN ('GTIN','ISBN');
--> statement-breakpoint
CREATE UNIQUE INDEX product_identifier_scoped_uq ON pmd.product_identifier (product_id, id_type, id_value);
--> statement-breakpoint
CREATE INDEX product_identifier_lookup_idx ON pmd.product_identifier (id_type, id_value);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. SPECIFICATIONS  (category-specific attributes: EAV, one value per source)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.attribute_definition (
  attribute_key      text PRIMARY KEY,
  attribute_label    text NOT NULL,
  attribute_group    text NOT NULL CHECK (attribute_group IN
    ('GENERAL','FOOD','ELECTRONICS','APPAREL','HOME','BEAUTY','COMPLIANCE','OTHER')),
  data_type          text NOT NULL CHECK (data_type IN ('TEXT','NUMBER','BOOLEAN')),
  canonical_unit     text,
  -- SPEC: manufacturer/brand data wins. MARKETPLACE: availability/price/rating style facts.
  source_authority   text NOT NULL DEFAULT 'SPEC' CHECK (source_authority IN ('SPEC','MARKETPLACE')),
  track_conflicts    boolean NOT NULL DEFAULT true,
  description        text,
  sort_order         integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE pmd.product_specification (
  spec_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         bigint NOT NULL REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  attribute_key      text   NOT NULL REFERENCES pmd.attribute_definition (attribute_key),
  value_text         text,
  value_num          numeric(20,6),
  value_bool         boolean,
  unit               text,
  original_value     text,
  source_id          smallint NOT NULL REFERENCES pmd.source (source_id),
  source_url         text,
  confidence         numeric(5,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  collected_at       timestamptz NOT NULL DEFAULT now(),
  is_preferred       boolean NOT NULL DEFAULT false,
  UNIQUE (product_id, attribute_key, source_id),
  CONSTRAINT product_specification_has_value CHECK (num_nonnulls(value_text, value_num, value_bool) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX product_specification_preferred_uq ON pmd.product_specification (product_id, attribute_key)
  WHERE is_preferred;
--> statement-breakpoint

CREATE TABLE pmd.product_attribute_conflict (
  conflict_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         bigint NOT NULL REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  attribute_key      text   NOT NULL,
  value_1            text   NOT NULL,
  source_1           text   NOT NULL,
  value_2            text   NOT NULL,
  source_2           text   NOT NULL,
  conflict_status    text   NOT NULL DEFAULT 'OPEN' CHECK (conflict_status IN ('OPEN','AUTO_RESOLVED','MANUALLY_RESOLVED','IGNORED')),
  resolution         text,
  resolution_source  text,
  resolution_date    timestamptz,
  detected_at        timestamptz NOT NULL DEFAULT now(),
  detected_run_id    bigint REFERENCES pmd.ingestion_run (run_id)
);
--> statement-breakpoint
CREATE INDEX product_attribute_conflict_product_idx ON pmd.product_attribute_conflict (product_id);
--> statement-breakpoint
CREATE UNIQUE INDEX product_attribute_conflict_dedupe_uq
  ON pmd.product_attribute_conflict (product_id, attribute_key, source_1, source_2, md5(value_1 || chr(31) || value_2));
--> statement-breakpoint
CREATE INDEX product_attribute_conflict_open_idx ON pmd.product_attribute_conflict (conflict_status) WHERE conflict_status = 'OPEN';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. SOURCE RECORDS, OFFERS (seller-level), PRICE HISTORY
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.product_source (
  product_source_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id            bigint REFERENCES pmd.product_master (product_id),   -- NULL while awaiting review
  source_id             smallint NOT NULL REFERENCES pmd.source (source_id),
  source_product_id     text NOT NULL,
  source_url            text,
  source_category       text,
  source_product_name   text,
  source_brand          text,
  source_mrp_minor      bigint CHECK (source_mrp_minor IS NULL OR source_mrp_minor >= 0),
  source_price_minor    bigint CHECK (source_price_minor IS NULL OR source_price_minor >= 0),
  source_currency       char(3),
  source_rating         numeric(4,2),
  source_review_count   integer,
  source_availability   text,
  first_seen_date       date NOT NULL,
  last_seen_date        date NOT NULL,
  data_collection_date  date NOT NULL,
  data_collection_method text NOT NULL,
  data_confidence       numeric(5,2) CHECK (data_confidence IS NULL OR data_confidence BETWEEN 0 AND 100),
  -- how this record was tied to a master product
  match_status          text NOT NULL DEFAULT 'NO_CANDIDATE' CHECK (match_status IN
    ('EXACT_MATCH','HIGH_CONFIDENCE','POSSIBLE_MATCH','DIFFERENT_PRODUCT','NEEDS_REVIEW','NO_CANDIDATE')),
  match_score           numeric(5,2) CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 100),
  match_rule            text,
  resolution            text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (resolution IN
    ('LINKED_EXISTING','CREATED_NEW','PENDING_REVIEW','MANUAL_LINK')),
  content_hash          text,
  normalized            jsonb,
  raw_id                bigint REFERENCES pmd.raw_record (raw_id) ON DELETE SET NULL,
  last_run_id           bigint REFERENCES pmd.ingestion_run (run_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_product_id)
);
--> statement-breakpoint
CREATE INDEX product_source_product_idx  ON pmd.product_source (product_id);
--> statement-breakpoint
CREATE INDEX product_source_seen_idx     ON pmd.product_source (source_id, last_seen_date);
--> statement-breakpoint
CREATE INDEX product_source_pending_idx  ON pmd.product_source (resolution) WHERE resolution = 'PENDING_REVIEW';
--> statement-breakpoint
CREATE TRIGGER product_source_touch BEFORE UPDATE ON pmd.product_source FOR EACH ROW EXECUTE FUNCTION pmd.touch_updated_at();
--> statement-breakpoint

-- PRODUCT_SELLER: current state of one seller's offer for one source listing.
CREATE TABLE pmd.product_offer (
  offer_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_source_id   bigint NOT NULL REFERENCES pmd.product_source (product_source_id) ON DELETE CASCADE,
  product_id          bigint REFERENCES pmd.product_master (product_id),
  source_id           smallint NOT NULL REFERENCES pmd.source (source_id),
  source_product_id   text NOT NULL,
  seller_key          text NOT NULL,                          -- seller_id, else lower(seller_name), else ''
  seller_id           text,
  seller_name         text,
  seller_location     text,
  seller_rating       numeric(4,2),
  price_minor         bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  mrp_minor           bigint CHECK (mrp_minor IS NULL OR mrp_minor >= 0),
  discount_minor      bigint,
  discount_pct        numeric(6,2),
  currency            char(3) NOT NULL DEFAULT 'INR',
  tax_inclusive       boolean,
  stock_status        text NOT NULL DEFAULT 'UNKNOWN' CHECK (stock_status IN ('IN_STOCK','OUT_OF_STOCK','LIMITED','UNKNOWN')),
  delivery_information text,
  source_url          text,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  collection_date     date NOT NULL,
  collected_at        timestamptz NOT NULL,
  is_current          boolean NOT NULL DEFAULT true,
  UNIQUE (product_source_id, seller_key)
);
--> statement-breakpoint
CREATE INDEX product_offer_product_idx ON pmd.product_offer (product_id) WHERE is_current;
--> statement-breakpoint
CREATE INDEX product_offer_source_seen_idx ON pmd.product_offer (source_id, last_seen_at);
--> statement-breakpoint

-- PRODUCT_PRICE_HISTORY: append-only, one row per observed change (and per first sighting).
-- Range-partitioned by month so 100M+ rows stay prunable and old months can be archived.
CREATE TABLE pmd.price_history (
  price_history_id  bigint GENERATED ALWAYS AS IDENTITY,
  product_id        bigint NOT NULL REFERENCES pmd.product_master (product_id),
  offer_id          bigint REFERENCES pmd.product_offer (offer_id),
  source_id         smallint NOT NULL REFERENCES pmd.source (source_id),
  seller_key        text NOT NULL,
  seller_name       text,
  mrp_minor         bigint,
  selling_price_minor bigint,
  discount_minor    bigint,
  currency          char(3) NOT NULL DEFAULT 'INR',
  stock_status      text NOT NULL DEFAULT 'UNKNOWN',
  change_reason     text NOT NULL DEFAULT 'FIRST_SEEN' CHECK (change_reason IN
    ('FIRST_SEEN','PRICE_CHANGED','MRP_CHANGED','STOCK_CHANGED','PRICE_AND_STOCK_CHANGED')),
  collection_date   date NOT NULL,
  collected_at      timestamptz NOT NULL,
  run_id            bigint,
  PRIMARY KEY (price_history_id, collected_at)
) PARTITION BY RANGE (collected_at);
--> statement-breakpoint
CREATE TABLE pmd.price_history_default PARTITION OF pmd.price_history DEFAULT;
--> statement-breakpoint
CREATE INDEX price_history_product_idx ON pmd.price_history (product_id, collected_at DESC);
--> statement-breakpoint
CREATE INDEX price_history_offer_idx   ON pmd.price_history (offer_id, collected_at DESC);
--> statement-breakpoint
CREATE INDEX price_history_collected_brin ON pmd.price_history USING brin (collected_at);
--> statement-breakpoint

CREATE FUNCTION pmd.ensure_price_history_partitions(p_from date, p_to date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  d    date := date_trunc('month', p_from)::date;
  made integer := 0;
  part text;
BEGIN
  WHILE d <= p_to LOOP
    part := format('price_history_%s', to_char(d, 'YYYY_MM'));
    IF to_regclass(format('pmd.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE pmd.%I PARTITION OF pmd.price_history FOR VALUES FROM (%L) TO (%L)',
        part, d, (d + interval '1 month')::date);
      made := made + 1;
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
  RETURN made;
END $$;
--> statement-breakpoint
-- Pre-create a wide window so nothing lands in the DEFAULT partition (creating a partition
-- whose range already has rows in DEFAULT would fail). The pipeline extends this window.
SELECT pmd.ensure_price_history_partitions('2022-01-01', '2030-12-31');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. IMAGES  (URLs only - images are never copied or redistributed)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.product_image (
  image_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         bigint NOT NULL REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  rank               smallint NOT NULL DEFAULT 0 CHECK (rank BETWEEN 0 AND 20),   -- 0 = primary
  image_url          text NOT NULL,
  image_source       text NOT NULL,
  source_id          smallint REFERENCES pmd.source (source_id),
  validation_status  text NOT NULL DEFAULT 'UNVALIDATED' CHECK (validation_status IN ('UNVALIDATED','VALID','BROKEN','RESTRICTED')),
  license_note       text,
  checked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, image_url)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. MATCH REVIEW QUEUE, MERGES, CHANGE LOG
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.match_candidate (
  candidate_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_source_id     bigint NOT NULL REFERENCES pmd.product_source (product_source_id) ON DELETE CASCADE,
  candidate_product_id  bigint NOT NULL REFERENCES pmd.product_master (product_id),
  match_score           numeric(5,2) NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  match_status          text NOT NULL CHECK (match_status IN
    ('EXACT_MATCH','HIGH_CONFIDENCE','POSSIBLE_MATCH','DIFFERENT_PRODUCT','NEEDS_REVIEW')),
  relation              text NOT NULL DEFAULT 'UNRELATED' CHECK (relation IN
    ('SAME_PRODUCT','SAME_FAMILY_DIFFERENT_PACK','SAME_FAMILY_DIFFERENT_VARIANT','SAME_BRAND_DIFFERENT_PRODUCT','UNRELATED')),
  reasons               jsonb  NOT NULL DEFAULT '{}'::jsonb,
  hard_conflicts        text[] NOT NULL DEFAULT '{}',
  review_status         text   NOT NULL DEFAULT 'PENDING' CHECK (review_status IN
    ('PENDING','AUTO_LINKED','CONFIRMED_SAME','CONFIRMED_DIFFERENT','SAME_FAMILY')),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  created_run_id        bigint REFERENCES pmd.ingestion_run (run_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_source_id, candidate_product_id)
);
--> statement-breakpoint
CREATE INDEX match_candidate_queue_idx ON pmd.match_candidate (review_status, match_status) WHERE review_status = 'PENDING';
--> statement-breakpoint
CREATE INDEX match_candidate_product_idx ON pmd.match_candidate (candidate_product_id);
--> statement-breakpoint

CREATE TABLE pmd.product_merge_log (
  merge_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_product_id    bigint NOT NULL REFERENCES pmd.product_master (product_id),
  into_product_id    bigint NOT NULL REFERENCES pmd.product_master (product_id),
  reason             text,
  merged_by          text NOT NULL,
  merged_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (from_product_id <> into_product_id)
);
--> statement-breakpoint

-- VERSION HISTORY: every field the pipeline or a person changes on a master record.
CREATE TABLE pmd.product_change_log (
  change_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    bigint NOT NULL,
  entity        text   NOT NULL,           -- product_master | specification | identifier | image | status
  entity_key    text,
  field_name    text   NOT NULL,
  old_value     jsonb,
  new_value     jsonb,
  source_id     smallint,
  run_id        bigint,
  changed_by    text   NOT NULL DEFAULT 'system',
  changed_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX product_change_log_product_idx ON pmd.product_change_log (product_id, changed_at DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. BRIDGE TO THE LIVE MARKETPLACE CATALOGUE
-- ---------------------------------------------------------------------------
-- master product -> public.products (GOKESARI_PRODUCT_CATALOG) -> public.shop_products.
-- Shops pick an existing catalogue product; they never re-create it. Seller pricing is never copied here.
CREATE TABLE pmd.catalogue_link (
  product_id            bigint PRIMARY KEY REFERENCES pmd.product_master (product_id),
  catalogue_product_id  uuid   NOT NULL UNIQUE REFERENCES public.products (id),
  promoted_at           timestamptz NOT NULL DEFAULT now(),
  promoted_by           uuid REFERENCES public.users (id),
  promotion_note        text
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. WORK QUEUE  (PostgreSQL-native: FOR UPDATE SKIP LOCKED, no extra infrastructure)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.job (
  job_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type      text NOT NULL,
  run_id        bigint REFERENCES pmd.ingestion_run (run_id) ON DELETE CASCADE,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','DEAD')),
  priority      smallint NOT NULL DEFAULT 5,
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
--> statement-breakpoint
CREATE INDEX job_claim_idx ON pmd.job (priority, run_after, job_id) WHERE status = 'PENDING';
--> statement-breakpoint

-- Atomically claim the next runnable job. Concurrent workers never receive the same row.
-- Jobs whose lock is older than p_stale are treated as abandoned and re-claimable.
CREATE FUNCTION pmd.claim_job(p_types text[], p_worker text, p_stale interval DEFAULT interval '15 minutes')
RETURNS SETOF pmd.job LANGUAGE sql AS $$
  WITH next AS (
    SELECT job_id FROM pmd.job
    WHERE job_type = ANY (p_types)
      AND run_after <= now()
      AND attempts < max_attempts
      AND (status = 'PENDING' OR (status = 'RUNNING' AND locked_at < now() - p_stale))
    ORDER BY priority, run_after, job_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE pmd.job j
     SET status = 'RUNNING', locked_by = p_worker, locked_at = now(), attempts = j.attempts + 1
    FROM next
   WHERE j.job_id = next.job_id
  RETURNING j.*;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. READ MODELS
-- ---------------------------------------------------------------------------
CREATE VIEW pmd.v_product_flat AS
SELECT
  pm.*,
  b.brand_name,
  b.brand_code,
  m.manufacturer_name,
  m.manufacturer_code,
  c.category_code,
  c.path_names[1] AS category_level_1,
  c.path_names[2] AS category_level_2,
  c.path_names[3] AS category_level_3,
  c.path_names[4] AS category_level_4,
  c.path_names[5] AS category_level_5,
  pf.family_name  AS product_family
FROM pmd.product_master pm
LEFT JOIN pmd.brand          b  ON b.brand_id = pm.brand_id
LEFT JOIN pmd.manufacturer   m  ON m.manufacturer_id = pm.manufacturer_id
LEFT JOIN pmd.category       c  ON c.category_id = pm.category_id
LEFT JOIN pmd.product_family pf ON pf.family_id = pm.product_family_id;
--> statement-breakpoint

-- Per-product price picture across current offers. Derived, never stored on the product.
CREATE VIEW pmd.v_product_price_summary AS
SELECT
  o.product_id,
  count(*)                                             AS offer_count,
  count(*) FILTER (WHERE o.stock_status IN ('IN_STOCK','LIMITED')) AS in_stock_offer_count,
  min(o.price_minor)                                   AS min_price_minor,
  max(o.price_minor)                                   AS max_price_minor,
  round(avg(o.price_minor))::bigint                    AS avg_price_minor,
  max(o.mrp_minor)                                     AS max_mrp_minor,
  max(o.currency)                                      AS currency,
  max(o.collected_at)                                  AS last_collected_at
FROM pmd.product_offer o
WHERE o.is_current AND o.product_id IS NOT NULL
GROUP BY o.product_id;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. QUALITY DASHBOARD SNAPSHOT  (refreshed after each run; reads stay O(1) at 10M rows)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.dashboard_metric (
  metric       text NOT NULL,
  dimension    text NOT NULL DEFAULT '',
  value        numeric(20,2) NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, dimension)
);
--> statement-breakpoint

-- The reference data (sources, taxonomy, attribute registry, shipped category mappings) is defined in code.
-- The runner syncs it into the tables above only when its fingerprint differs from the one stored here -
-- NOT at the start of every run. (Re-upserting ~1,600 rows per run was slow over a network, and an
-- INSERT ... ON CONFLICT consumes an identity value even when it only updates: 41 per run from a smallint.)
CREATE TABLE pmd.reference_state (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  content_hash text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION pmd.refresh_dashboard(p_window interval DEFAULT interval '7 days') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Two runs finishing together must not both rebuild the snapshot at once (the second INSERT would hit the
  -- primary key): take a transaction-scoped lock so they queue, and the later one simply rebuilds it again.
  PERFORM pg_advisory_xact_lock(hashtextextended('pmd.refresh_dashboard', 0));
  DELETE FROM pmd.dashboard_metric;

  INSERT INTO pmd.dashboard_metric (metric, dimension, value)
  SELECT 'total_products', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE'
  UNION ALL SELECT 'new_products', '', count(*) FROM pmd.product_master
    WHERE record_status = 'ACTIVE' AND created_at >= now() - p_window
  UNION ALL SELECT 'updated_products', '', count(*) FROM pmd.product_master
    WHERE record_status = 'ACTIVE' AND created_at < now() - p_window AND updated_at >= now() - p_window
  UNION ALL SELECT 'duplicates_merged', '', count(*) FROM pmd.product_master WHERE record_status = 'MERGED'
  UNION ALL SELECT 'possible_duplicates', '', count(DISTINCT product_source_id) FROM pmd.match_candidate
    WHERE review_status = 'PENDING' AND match_status = 'POSSIBLE_MATCH'
  UNION ALL SELECT 'manual_review', '', count(DISTINCT product_source_id) FROM pmd.match_candidate
    WHERE review_status = 'PENDING' AND match_status IN ('POSSIBLE_MATCH','NEEDS_REVIEW')
  UNION ALL SELECT 'missing_gtin', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND gtin IS NULL
  UNION ALL SELECT 'missing_brand', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND brand_id IS NULL
  UNION ALL SELECT 'missing_manufacturer', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND manufacturer_id IS NULL
  UNION ALL SELECT 'missing_category', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND category_id IS NULL
  UNION ALL SELECT 'missing_gst', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND gst_rate_bp IS NULL
  UNION ALL SELECT 'missing_hsn', '', count(*) FROM pmd.product_master WHERE record_status = 'ACTIVE' AND hsn_code IS NULL
  UNION ALL SELECT 'missing_mrp', '', count(*) FROM pmd.product_master pm
    WHERE pm.record_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM pmd.product_offer o WHERE o.product_id = pm.product_id AND o.mrp_minor IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM pmd.product_source s WHERE s.product_id = pm.product_id AND s.source_mrp_minor IS NOT NULL)
  UNION ALL SELECT 'conflicting_specs', '', count(DISTINCT product_id) FROM pmd.product_attribute_conflict WHERE conflict_status = 'OPEN'
  UNION ALL SELECT 'avg_quality_score', '', COALESCE(round(avg(data_quality_score), 2), 0) FROM pmd.product_master
    WHERE record_status = 'ACTIVE' AND data_quality_score IS NOT NULL
  UNION ALL SELECT 'source_records', '', count(*) FROM pmd.product_source
  UNION ALL SELECT 'offers', '', count(*) FROM pmd.product_offer WHERE is_current
  UNION ALL SELECT 'price_observations', '', count(*) FROM pmd.price_history
  UNION ALL SELECT 'import_errors', '', count(*) FROM pmd.import_error WHERE severity = 'ERROR'
  UNION ALL SELECT 'by_marketplace', s.source_key, count(*)
    FROM pmd.product_source ps JOIN pmd.source s USING (source_id) GROUP BY s.source_key
  UNION ALL SELECT 'by_category', COALESCE(c.path_names[1], '(uncategorised)'), count(*)
    FROM pmd.product_master pm LEFT JOIN pmd.category c ON c.category_id = pm.category_id
    WHERE pm.record_status = 'ACTIVE' GROUP BY 2
  UNION ALL SELECT 'by_brand', t.brand_name, t.n FROM (
      SELECT COALESCE(b.brand_name, '(no brand)') AS brand_name, count(*) AS n
      FROM pmd.product_master pm LEFT JOIN pmd.brand b ON b.brand_id = pm.brand_id
      WHERE pm.record_status = 'ACTIVE' GROUP BY 1 ORDER BY 2 DESC LIMIT 50) t;
END $$;
