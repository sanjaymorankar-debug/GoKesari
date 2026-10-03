-- ============================================================================
-- PMD 0000  Product Master Data Platform  —  MySQL
--
-- Ported from drizzle-postgres-legacy/0015_product_master_platform.sql, which
-- built this schema on PostgreSQL. Hand-written, as that one was: partitioned
-- tables, functional indexes and generated identifiers are not expressible in
-- Drizzle's schema DSL, and PMD talks to the driver directly rather than
-- through the ORM.
--
-- Applied by `npm run pmd:migrate` against its own database, NOT by
-- `npm run db:migrate`. See docs/PMD_MYSQL_PORT.md.
--
-- `pmd` IS A DATABASE HERE. PostgreSQL had a schema named `pmd` inside the
-- application's database. MySQL has no schema-within-a-database, but its
-- `database.table` syntax is the same two-part name, so a database called
-- `pmd` leaves all ~200 `pmd.<table>` references in the application code
-- working unchanged. It has to live on the same server as the application
-- database, because catalogue_link points at it (section 11).
--
-- Conventions carried over unchanged:
--   * Money is integer minor units (paise for INR) + an explicit currency column.
--   * Every score (match, quality, confidence) is numeric 0-100.
--   * Missing data is NULL, never 0 / '' (Excel export renders NOT_AVAILABLE).
--   * Enumerations are text + CHECK (adding a value is a cheap ALTER).
--   * History is append-only; nothing here is ever deleted by the pipeline.
--
-- What MySQL forced to change, and where to read about it:
--   * `text` is `varchar(n)` wherever it is indexed, unique or part of a key —
--     MySQL cannot index TEXT without a prefix length.
--   * `timestamptz` is `datetime(3)`; the connection is pinned to UTC and every
--     default is CURRENT_TIMESTAMP(3). TIMESTAMP was rejected for its 2038
--     ceiling, and the (3) is load-bearing: without a precision MySQL keeps
--     whole seconds and "latest row wins" ordering stops being a total order.
--   * `jsonb` is `json`, with defaults in the expression form MySQL requires.
--   * `text[]` / `integer[]` are `json`.
--   * Partial UNIQUE indexes are a VIRTUAL generated column holding the
--     predicate plus a UNIQUE on it — NULL when the predicate is false, and a
--     unique index admits any number of NULLs. Partial NON-unique indexes are
--     simply full indexes: a superset, so no query loses its index.
--   * The four PL/pgSQL functions become TypeScript rather than MySQL stored
--     procedures. touch_updated_at() is gone entirely — MySQL has ON UPDATE
--     CURRENT_TIMESTAMP; the other three arrive with the pipeline port.
--   * pmd.price_history keeps its range partitioning and LOSES its three
--     foreign keys; MySQL refuses foreign keys on a partitioned table outright
--     (ER_FOREIGN_KEY_ON_PARTITIONED, 1506). See section 8.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. COUNTERS  (the three PostgreSQL sequences)
-- ---------------------------------------------------------------------------
-- manufacturer_seq, brand_seq and product_seq produced the ids that
-- manufacturer_code / brand_code / master_product_id are generated from.
--
-- They are NOT AUTO_INCREMENT: MySQL refuses to let a generated column refer to
-- an AUTO_INCREMENT column (ER_GENERATED_COLUMN_REF_AUTO_INC, 3109), which is
-- exactly what those three code columns do. The id is allocated from this table
-- instead, allocated by the application (see the counters idiom in
-- src/server/db/sequence.ts, which this mirrors).
CREATE TABLE pmd.counters (
  name  varchar(64) NOT NULL PRIMARY KEY,
  value bigint      NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 1. SOURCE REGISTRY  (the SOURCE_ADAPTER configuration)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.source (
  source_id             smallint     NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_key            varchar(191) NOT NULL UNIQUE,
  source_name           varchar(255) NOT NULL,
  source_kind           varchar(32)  NOT NULL,
  access_method         varchar(32)  NOT NULL,
  -- Only ACTIVE + enabled sources can ingest. BLOCKED_* rows exist so the gap is visible, not hidden.
  status                varchar(32)  NOT NULL DEFAULT 'PLANNED',
  enabled               boolean      NOT NULL DEFAULT false,
  reliability           smallint     NOT NULL DEFAULT 50,
  -- Lower wins when two sources disagree on a technical specification.
  spec_precedence       smallint     NOT NULL DEFAULT 50,
  legal_basis           text         NOT NULL,
  license_name          varchar(255),
  terms_url             text,
  robots_policy         text,
  api_endpoint          text,
  -- NAME of the environment variable holding credentials. Never the secret itself.
  auth_env_var          varchar(191),
  collection_frequency  varchar(64),
  rate_limit_per_min    integer,
  parser_key            varchar(191),
  field_mapping         json         NOT NULL DEFAULT ('{}'),
  retry_max             smallint     NOT NULL DEFAULT 3,
  last_success_at       datetime(3),
  last_run_products     integer,
  notes                 text,
  created_at            datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- ON UPDATE replaces the source_touch trigger
  updated_at            datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT source_kind_values CHECK (source_kind IN
    ('MARKETPLACE','BRAND_MANUFACTURER','GOVERNMENT','OPEN_DATA','LICENSED_FEED','GS1','DISTRIBUTOR','INTERNAL')),
  CONSTRAINT source_access_values CHECK (access_method IN
    ('OFFICIAL_API','LICENSED_FEED','OPEN_DATASET','MANUFACTURER_FEED','PERMITTED_PUBLIC_PAGE','INTERNAL_DB','MANUAL_UPLOAD','NONE')),
  CONSTRAINT source_status_values CHECK (status IN
    ('ACTIVE','PLANNED','BLOCKED_NEEDS_AGREEMENT','BLOCKED_TECHNICAL','DISABLED')),
  CONSTRAINT source_reliability_range CHECK (reliability BETWEEN 0 AND 100),
  CONSTRAINT source_enabled_requires_active CHECK (NOT enabled OR status = 'ACTIVE')
);

-- ---------------------------------------------------------------------------
-- 2. COLLECTION LOG, IMPORT ERRORS, RAW STAGING
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.ingestion_run (
  run_id            bigint      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id         smallint    NOT NULL,
  run_mode          varchar(32) NOT NULL,
  status            varchar(32) NOT NULL DEFAULT 'RUNNING',
  started_at        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at       datetime(3),
  triggered_by      varchar(191) NOT NULL DEFAULT 'system',
  params            json        NOT NULL DEFAULT ('{}'),
  records_read      integer     NOT NULL DEFAULT 0,
  records_staged    integer     NOT NULL DEFAULT 0,
  records_unchanged integer     NOT NULL DEFAULT 0,
  products_created  integer     NOT NULL DEFAULT 0,
  products_linked   integer     NOT NULL DEFAULT 0,
  products_updated  integer     NOT NULL DEFAULT 0,
  offers_upserted   integer     NOT NULL DEFAULT 0,
  price_changes     integer     NOT NULL DEFAULT 0,
  review_queued     integer     NOT NULL DEFAULT 0,
  conflicts_opened  integer     NOT NULL DEFAULT 0,
  error_count       integer     NOT NULL DEFAULT 0,
  error_summary     text,
  CONSTRAINT ingestion_run_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT ingestion_run_mode_values CHECK (run_mode IN ('PILOT','INITIAL_FULL','INCREMENTAL','IMPORT','BACKFILL')),
  CONSTRAINT ingestion_run_status_values CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
  KEY ingestion_run_source_idx (source_id, started_at DESC)
);

CREATE TABLE pmd.import_error (
  error_id          bigint      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id            bigint,
  source_id         smallint,
  source_record_id  varchar(191),
  stage             varchar(32) NOT NULL,
  severity          varchar(16) NOT NULL DEFAULT 'ERROR',
  error_code        varchar(64) NOT NULL,
  message          text         NOT NULL,
  raw_excerpt       json,
  created_at        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT import_error_run_fk FOREIGN KEY (run_id) REFERENCES pmd.ingestion_run (run_id) ON DELETE CASCADE,
  CONSTRAINT import_error_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT import_error_stage_values CHECK (stage IN ('EXTRACT','PARSE','NORMALIZE','MATCH','VALIDATE','LOAD')),
  CONSTRAINT import_error_severity_values CHECK (severity IN ('ERROR','WARNING')),
  KEY import_error_run_idx (run_id)
);

-- Raw payload of every *changed* source record, kept for traceability and replay.
CREATE TABLE pmd.raw_record (
  raw_id            bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id            bigint,
  source_id         smallint     NOT NULL,
  source_product_id varchar(191) NOT NULL,
  content_hash      varchar(64)  NOT NULL,
  payload           json         NOT NULL,
  fetched_at        datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT raw_record_run_fk FOREIGN KEY (run_id) REFERENCES pmd.ingestion_run (run_id) ON DELETE SET NULL,
  CONSTRAINT raw_record_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  UNIQUE KEY raw_record_uq (source_id, source_product_id, content_hash)
);

-- ---------------------------------------------------------------------------
-- 3. TAXONOMY  (CATEGORY_MASTER, CATEGORY_MAPPING)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.category (
  category_id         integer      NOT NULL AUTO_INCREMENT PRIMARY KEY,  -- Standard_Category_ID
  category_code       varchar(191) NOT NULL UNIQUE,                       -- slug path: grocery/staples/rice
  parent_id           integer,
  level               smallint     NOT NULL,
  name                varchar(255) NOT NULL,
  slug                varchar(191) NOT NULL,
  path_names          json         NOT NULL,                              -- was text[]
  path_ids            json         NOT NULL,                              -- was integer[]
  gokesari_department varchar(64),                                        -- informational: SHOP_TYPE key
  description         text,
  sort_order          integer      NOT NULL DEFAULT 0,
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT category_parent_fk FOREIGN KEY (parent_id) REFERENCES pmd.category (category_id),
  CONSTRAINT category_level_range CHECK (level BETWEEN 1 AND 5),
  -- cardinality(path_names) -> JSON_LENGTH; deterministic, so a CHECK may use it
  CONSTRAINT category_level_matches_path CHECK (level = JSON_LENGTH(path_names)),
  CONSTRAINT category_parent_level CHECK ((level = 1) = (parent_id IS NULL)),
  KEY category_parent_idx (parent_id)
);

CREATE TABLE pmd.category_mapping (
  mapping_id                bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id                 smallint     NOT NULL,
  source_category           varchar(191) NOT NULL,            -- normalized lookup key
  source_category_original  text         NOT NULL,
  standard_category_id      integer      NOT NULL,
  match_type                varchar(16)  NOT NULL DEFAULT 'EXACT',
  confidence                decimal(5,2) NOT NULL DEFAULT 100,
  mapped_by                 varchar(64)  NOT NULL DEFAULT 'SYSTEM',
  is_active                 boolean      NOT NULL DEFAULT true,
  created_at                datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT category_mapping_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT category_mapping_std_fk FOREIGN KEY (standard_category_id) REFERENCES pmd.category (category_id),
  CONSTRAINT category_mapping_match_values CHECK (match_type IN ('EXACT','PREFIX','KEYWORD','MANUAL')),
  CONSTRAINT category_mapping_confidence_range CHECK (confidence BETWEEN 0 AND 100),
  UNIQUE KEY category_mapping_uq (source_id, source_category),
  KEY category_mapping_std_idx (standard_category_id)
);

-- ---------------------------------------------------------------------------
-- 4. MANUFACTURER MASTER, BRAND MASTER  (+ aliases preserve every source spelling)
-- ---------------------------------------------------------------------------
-- manufacturer_id / brand_id come from pmd.counters (section 0), not
-- AUTO_INCREMENT, because the *_code columns below are generated from them.
CREATE TABLE pmd.manufacturer (
  manufacturer_id     bigint       NOT NULL PRIMARY KEY,
  manufacturer_code   varchar(32)
    GENERATED ALWAYS AS (CONCAT('GKS-MFR-', LPAD(manufacturer_id, 9, '0'))) STORED NOT NULL UNIQUE,
  manufacturer_name   varchar(255) NOT NULL,
  manufacturer_key    varchar(191) NOT NULL UNIQUE,
  legal_name          varchar(255),
  address             text,
  country             varchar(64),
  gstin               varchar(20),
  website             text,
  contact_information text,
  source_id           smallint,
  verification_status varchar(16)  NOT NULL DEFAULT 'UNVERIFIED',
  created_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT manufacturer_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  -- `gstin ~ '...'` -> REGEXP_LIKE, which is deterministic and so allowed in a CHECK
  CONSTRAINT manufacturer_gstin_format CHECK (
    gstin IS NULL OR REGEXP_LIKE(gstin, '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')),
  CONSTRAINT manufacturer_verification_values CHECK (verification_status IN ('UNVERIFIED','VERIFIED','DISPUTED'))
);

CREATE TABLE pmd.manufacturer_alias (
  alias_key         varchar(191) NOT NULL PRIMARY KEY,
  manufacturer_id   bigint       NOT NULL,
  alias_original    varchar(255) NOT NULL,
  source_id         smallint,
  first_seen_at     datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT manufacturer_alias_mfr_fk FOREIGN KEY (manufacturer_id) REFERENCES pmd.manufacturer (manufacturer_id) ON DELETE CASCADE,
  CONSTRAINT manufacturer_alias_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  KEY manufacturer_alias_mfr_idx (manufacturer_id)
);

CREATE TABLE pmd.brand (
  brand_id            bigint       NOT NULL PRIMARY KEY,
  brand_code          varchar(32)
    GENERATED ALWAYS AS (CONCAT('GKS-BRND-', LPAD(brand_id, 9, '0'))) STORED NOT NULL UNIQUE,
  brand_name          varchar(255) NOT NULL,
  brand_key           varchar(191) NOT NULL UNIQUE,
  legal_company_name  varchar(255),
  manufacturer_id     bigint,
  country             varchar(64),
  website             text,
  primary_category_id integer,
  brand_status        varchar(16)  NOT NULL DEFAULT 'ACTIVE',
  source_id           smallint,
  verification_status varchar(16)  NOT NULL DEFAULT 'UNVERIFIED',
  created_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT brand_manufacturer_fk FOREIGN KEY (manufacturer_id) REFERENCES pmd.manufacturer (manufacturer_id),
  CONSTRAINT brand_category_fk FOREIGN KEY (primary_category_id) REFERENCES pmd.category (category_id),
  CONSTRAINT brand_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT brand_status_values CHECK (brand_status IN ('ACTIVE','INACTIVE','UNVERIFIED')),
  CONSTRAINT brand_verification_values CHECK (verification_status IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  KEY brand_manufacturer_idx (manufacturer_id),
  -- brand_name_trgm_idx (GIN + gin_trgm_ops) is NOT here; fuzzy retrieval
  -- indexes come in a later migration, once the replacement for pg_trgm has
  -- been measured. A plain index still serves exact and prefix lookups.
  KEY brand_name_idx (brand_name)
);

-- "Samsung", "SAMSUNG", "Samsung India" -> one brand; each original spelling kept.
CREATE TABLE pmd.brand_alias (
  alias_key         varchar(191) NOT NULL PRIMARY KEY,
  brand_id          bigint       NOT NULL,
  alias_original    varchar(255) NOT NULL,
  source_id         smallint,
  first_seen_at     datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT brand_alias_brand_fk FOREIGN KEY (brand_id) REFERENCES pmd.brand (brand_id) ON DELETE CASCADE,
  CONSTRAINT brand_alias_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  KEY brand_alias_brand_idx (brand_id)
);

-- ---------------------------------------------------------------------------
-- 5. PRODUCT FAMILY + PRODUCT MASTER
-- ---------------------------------------------------------------------------
-- A family groups the pack sizes / variants of one product line. Two members of a
-- family are DIFFERENT products (own master record, own GTIN) - the family only
-- records that they are related.
CREATE TABLE pmd.product_family (
  family_id    bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  brand_id     bigint,
  family_key   varchar(191) NOT NULL,
  family_name  varchar(255) NOT NULL,
  category_id  integer,
  created_at   datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- `UNIQUE (COALESCE(brand_id, 0), family_key)` was an expression index. A
  -- generated column carries the expression instead: MySQL 8 would also take a
  -- functional index, but MariaDB takes neither, and this form works on both.
  family_brand_key varchar(212)
    GENERATED ALWAYS AS (CONCAT(COALESCE(brand_id, 0), ':', family_key)) VIRTUAL NOT NULL,
  CONSTRAINT product_family_brand_fk FOREIGN KEY (brand_id) REFERENCES pmd.brand (brand_id),
  CONSTRAINT product_family_category_fk FOREIGN KEY (category_id) REFERENCES pmd.category (category_id),
  UNIQUE KEY product_family_uq (family_brand_key)
);

-- product_id comes from pmd.counters (section 0): master_product_id is generated
-- from it, and MySQL will not generate a column from an AUTO_INCREMENT one.
CREATE TABLE pmd.product_master (
  product_id         bigint NOT NULL PRIMARY KEY,
  master_product_id  varchar(32)
    GENERATED ALWAYS AS (CONCAT('GKS-PROD-', LPAD(product_id, 9, '0'))) STORED NOT NULL UNIQUE,

  -- identification ---------------------------------------------------------
  product_family_id  bigint,
  brand_id           bigint,
  manufacturer_id    bigint,
  gtin               varchar(14),                              -- canonical GTIN-14 (EAN-13 / UPC-A / GTIN-8 zero-padded)
  ean                varchar(13),                              -- display forms derived from gtin
  upc                varchar(12),
  isbn               varchar(13),
  sku                varchar(191),
  mpn                varchar(191),
  model_number       varchar(191),
  product_code       varchar(191),

  -- description ------------------------------------------------------------
  product_name       varchar(512) NOT NULL,
  normalized_name    varchar(512) NOT NULL,                    -- name minus brand/pack/variant tokens, used to match
  search_text        text         NOT NULL,                    -- brand + name + variant + model, used to search
  short_description  text,
  long_description   text,
  product_type       varchar(191),
  sub_type           varchar(191),
  variant_name       varchar(255),
  variant_code       varchar(191),
  key_features       json         NOT NULL DEFAULT ('[]'),
  search_keywords    json         NOT NULL DEFAULT ('[]'),     -- was text[]

  -- classification ---------------------------------------------------------
  category_id        integer,

  -- physical (canonical units: g, ml, mm, pcs; original text lives in specifications) ---
  net_weight_g       decimal(16,4),
  gross_weight_g     decimal(16,4),
  weight_unit        varchar(8)  NOT NULL DEFAULT 'g',
  length_mm          decimal(16,3),
  width_mm           decimal(16,3),
  height_mm          decimal(16,3),
  dimension_unit     varchar(8)  NOT NULL DEFAULT 'mm',
  volume_ml          decimal(16,4),
  volume_unit        varchar(8)  NOT NULL DEFAULT 'ml',
  net_quantity_value decimal(16,4),
  net_quantity_unit  varchar(8),
  pack_size          varchar(64),
  pack_count         integer,
  unit_count         integer,
  material           varchar(191),
  color              varchar(64),
  size               varchar(64),
  shape              varchar(64),

  -- tax (NOT price: MRP / selling price are per-offer, per-date - see product_offer) ---
  gst_rate_bp        integer,
  hsn_code           varchar(8),
  cess_bp            integer,
  other_taxes        json,

  -- lifecycle ----------------------------------------------------------------
  product_status     varchar(32) NOT NULL DEFAULT 'UNKNOWN',
  status_basis       varchar(191),
  status_updated_at  datetime(3),
  record_status      varchar(16) NOT NULL DEFAULT 'ACTIVE',
  merged_into_product_id bigint,

  -- provenance for master columns that are not in product_specification:
  -- {"product_name": <source_id>, "category_id": <source_id>, ...}
  field_sources      json NOT NULL DEFAULT ('{}'),

  -- data quality / governance -------------------------------------------------
  data_quality_score decimal(5,2),
  quality_components json,
  quality_computed_at datetime(3),
  match_confidence   decimal(5,2),
  version            integer     NOT NULL DEFAULT 1,
  created_run_id     bigint,
  first_seen_at      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at       datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at         datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- No ON UPDATE here, deliberately, matching the PostgreSQL original: updated_at
  -- means "a business field changed" and is set by the loader. Maintaining it
  -- automatically would also fire for quality-score and status recomputes and
  -- make every refreshed product look freshly updated on the dashboard.
  updated_at         datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- One ACTIVE master per GTIN. Merged/suppressed rows keep their historic
  -- value, which is why the PostgreSQL index was partial; the predicate lives
  -- in this generated column, NULL when it does not hold.
  active_gtin_key varchar(14)
    GENERATED ALWAYS AS (CASE WHEN gtin IS NOT NULL AND record_status = 'ACTIVE' THEN gtin END) VIRTUAL,

  CONSTRAINT product_master_family_fk FOREIGN KEY (product_family_id) REFERENCES pmd.product_family (family_id),
  CONSTRAINT product_master_brand_fk FOREIGN KEY (brand_id) REFERENCES pmd.brand (brand_id),
  CONSTRAINT product_master_mfr_fk FOREIGN KEY (manufacturer_id) REFERENCES pmd.manufacturer (manufacturer_id),
  CONSTRAINT product_master_category_fk FOREIGN KEY (category_id) REFERENCES pmd.category (category_id),
  CONSTRAINT product_master_merged_fk FOREIGN KEY (merged_into_product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT product_master_run_fk FOREIGN KEY (created_run_id) REFERENCES pmd.ingestion_run (run_id),

  CONSTRAINT product_master_gtin_format CHECK (gtin IS NULL OR REGEXP_LIKE(gtin, '^[0-9]{14}$')),
  CONSTRAINT product_master_hsn_format CHECK (hsn_code IS NULL OR REGEXP_LIKE(hsn_code, '^[0-9]{4}([0-9]{2}){0,2}$')),
  CONSTRAINT product_master_weight_nonneg CHECK (net_weight_g IS NULL OR net_weight_g >= 0),
  CONSTRAINT product_master_gross_nonneg CHECK (gross_weight_g IS NULL OR gross_weight_g >= 0),
  CONSTRAINT product_master_length_nonneg CHECK (length_mm IS NULL OR length_mm >= 0),
  CONSTRAINT product_master_width_nonneg CHECK (width_mm IS NULL OR width_mm >= 0),
  CONSTRAINT product_master_height_nonneg CHECK (height_mm IS NULL OR height_mm >= 0),
  CONSTRAINT product_master_volume_nonneg CHECK (volume_ml IS NULL OR volume_ml >= 0),
  CONSTRAINT product_master_netqty_pos CHECK (net_quantity_value IS NULL OR net_quantity_value > 0),
  CONSTRAINT product_master_netqty_unit_values CHECK (net_quantity_unit IS NULL OR net_quantity_unit IN ('g','ml','pcs','mm')),
  CONSTRAINT product_master_pack_count_min CHECK (pack_count IS NULL OR pack_count >= 1),
  CONSTRAINT product_master_unit_count_min CHECK (unit_count IS NULL OR unit_count >= 1),
  CONSTRAINT product_master_gst_range CHECK (gst_rate_bp IS NULL OR gst_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT product_master_cess_nonneg CHECK (cess_bp IS NULL OR cess_bp >= 0),
  CONSTRAINT product_master_status_values CHECK (product_status IN
    ('ACTIVE','OUT_OF_STOCK','DISCONTINUED','TEMPORARILY_UNAVAILABLE','UNKNOWN')),
  CONSTRAINT product_master_record_status_values CHECK (record_status IN ('ACTIVE','MERGED','SUPPRESSED')),
  CONSTRAINT product_master_quality_range CHECK (data_quality_score IS NULL OR data_quality_score BETWEEN 0 AND 100),
  CONSTRAINT product_master_confidence_range CHECK (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 100),
  CONSTRAINT product_master_merge_consistent CHECK ((record_status = 'MERGED') = (merged_into_product_id IS NOT NULL)),

  UNIQUE KEY product_master_gtin_uq (active_gtin_key),
  KEY product_master_brand_cat_idx (brand_id, category_id),
  KEY product_master_category_idx (category_id),
  KEY product_master_family_idx (product_family_id),
  -- Same brand + identical core name = pack-size / variant siblings (family grouping).
  -- The PostgreSQL index was partial (brand_id IS NOT NULL); a full index is a
  -- superset, so the same queries use it. The same applies to the four below.
  KEY product_master_brand_name_idx (brand_id, normalized_name),
  KEY product_master_mfr_idx (manufacturer_id),
  KEY product_master_mpn_idx (brand_id, mpn),
  KEY product_master_model_idx (brand_id, model_number),
  KEY product_master_status_idx (product_status),
  KEY product_master_quality_idx (data_quality_score)
  -- The three fuzzy/full-text retrieval indexes (GIN + gin_trgm_ops, and the
  -- to_tsvector index) are NOT here. They have no direct MySQL equivalent and
  -- arrive in a later migration once the replacement has been measured; see
  -- docs/PMD_MYSQL_PORT.md.
);

-- ---------------------------------------------------------------------------
-- 6. IDENTIFIERS
-- ---------------------------------------------------------------------------
-- GTIN covers EAN-8/UPC-A/EAN-13/GTIN-14 (stored as GTIN-14). ISBN-13 is also a GTIN, so
-- a book carries both rows. MPN / MODEL / PRODUCT_CODE / SKU are NOT globally unique
-- (colour variants share a model), so only GTIN and ISBN are uniqueness-enforced.
CREATE TABLE pmd.product_identifier (
  identifier_id      bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id         bigint       NOT NULL,
  id_type            varchar(32)  NOT NULL,
  id_value           varchar(191) NOT NULL,
  id_value_original  varchar(191) NOT NULL,
  id_format          varchar(16),                     -- GTIN-8 / GTIN-12 / GTIN-13 / GTIN-14 / ISBN-10 / ISBN-13
  scope_brand_id     bigint,
  is_primary         boolean      NOT NULL DEFAULT false,
  check_digit_valid  boolean,
  source_id          smallint,
  first_seen_at      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- `UNIQUE (id_type, id_value) WHERE id_type IN ('GTIN','ISBN')`
  global_id_key      varchar(226)
    GENERATED ALWAYS AS (CASE WHEN id_type IN ('GTIN','ISBN') THEN CONCAT(id_type, ':', id_value) END) VIRTUAL,
  CONSTRAINT product_identifier_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  CONSTRAINT product_identifier_brand_fk FOREIGN KEY (scope_brand_id) REFERENCES pmd.brand (brand_id),
  CONSTRAINT product_identifier_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT product_identifier_type_values CHECK (id_type IN
    ('GTIN','ISBN','MPN','MODEL','PRODUCT_CODE','SKU','SOURCE_CODE','INTERNAL_BARCODE')),
  UNIQUE KEY product_identifier_global_uq (global_id_key),
  UNIQUE KEY product_identifier_scoped_uq (product_id, id_type, id_value),
  KEY product_identifier_lookup_idx (id_type, id_value)
);

-- ---------------------------------------------------------------------------
-- 7. SPECIFICATIONS  (category-specific attributes: EAV, one value per source)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.attribute_definition (
  attribute_key      varchar(191) NOT NULL PRIMARY KEY,
  attribute_label    varchar(255) NOT NULL,
  attribute_group    varchar(32)  NOT NULL,
  data_type          varchar(16)  NOT NULL,
  canonical_unit     varchar(16),
  -- SPEC: manufacturer/brand data wins. MARKETPLACE: availability/price/rating style facts.
  source_authority   varchar(16)  NOT NULL DEFAULT 'SPEC',
  track_conflicts    boolean      NOT NULL DEFAULT true,
  description        text,
  sort_order         integer      NOT NULL DEFAULT 0,
  CONSTRAINT attribute_group_values CHECK (attribute_group IN
    ('GENERAL','FOOD','ELECTRONICS','APPAREL','HOME','BEAUTY','COMPLIANCE','OTHER')),
  CONSTRAINT attribute_data_type_values CHECK (data_type IN ('TEXT','NUMBER','BOOLEAN')),
  CONSTRAINT attribute_authority_values CHECK (source_authority IN ('SPEC','MARKETPLACE'))
);

CREATE TABLE pmd.product_specification (
  spec_id            bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id         bigint       NOT NULL,
  attribute_key      varchar(191) NOT NULL,
  value_text         text,
  value_num          decimal(20,6),
  value_bool         boolean,
  unit               varchar(16),
  original_value     text,
  source_id          smallint     NOT NULL,
  source_url         text,
  confidence         decimal(5,2),
  collected_at       datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_preferred       boolean      NOT NULL DEFAULT false,
  -- `UNIQUE (product_id, attribute_key) WHERE is_preferred`
  preferred_key      varchar(212)
    GENERATED ALWAYS AS (CASE WHEN is_preferred THEN CONCAT(product_id, ':', attribute_key) END) VIRTUAL,
  CONSTRAINT product_specification_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  CONSTRAINT product_specification_attr_fk FOREIGN KEY (attribute_key) REFERENCES pmd.attribute_definition (attribute_key),
  CONSTRAINT product_specification_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT product_specification_confidence_range CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  -- num_nonnulls(value_text, value_num, value_bool) >= 1
  CONSTRAINT product_specification_has_value CHECK (
    (value_text IS NOT NULL) + (value_num IS NOT NULL) + (value_bool IS NOT NULL) >= 1),
  UNIQUE KEY product_specification_uq (product_id, attribute_key, source_id),
  UNIQUE KEY product_specification_preferred_uq (preferred_key)
);

CREATE TABLE pmd.product_attribute_conflict (
  conflict_id        bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id         bigint       NOT NULL,
  attribute_key      varchar(191) NOT NULL,
  value_1            text         NOT NULL,
  source_1           varchar(191) NOT NULL,
  value_2            text         NOT NULL,
  source_2           varchar(191) NOT NULL,
  conflict_status    varchar(32)  NOT NULL DEFAULT 'OPEN',
  resolution         text,
  resolution_source  varchar(191),
  resolution_date    datetime(3),
  detected_at        datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  detected_run_id    bigint,
  -- the index carried md5(value_1 || chr(31) || value_2) so two long values do
  -- not blow the key length; a generated column holds the same digest
  value_pair_digest  char(32)
    GENERATED ALWAYS AS (MD5(CONCAT(value_1, CHAR(31), value_2))) VIRTUAL NOT NULL,
  CONSTRAINT product_attribute_conflict_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  CONSTRAINT product_attribute_conflict_run_fk FOREIGN KEY (detected_run_id) REFERENCES pmd.ingestion_run (run_id),
  CONSTRAINT product_attribute_conflict_status_values CHECK (conflict_status IN
    ('OPEN','AUTO_RESOLVED','MANUALLY_RESOLVED','IGNORED')),
  KEY product_attribute_conflict_product_idx (product_id),
  UNIQUE KEY product_attribute_conflict_dedupe_uq (product_id, attribute_key, source_1, source_2, value_pair_digest),
  KEY product_attribute_conflict_open_idx (conflict_status)
);

-- ---------------------------------------------------------------------------
-- 8. SOURCE RECORDS, OFFERS (seller-level), PRICE HISTORY
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.product_source (
  product_source_id     bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id            bigint,                                -- NULL while awaiting review
  source_id             smallint     NOT NULL,
  source_product_id     varchar(191) NOT NULL,
  source_url            text,
  source_category       varchar(255),
  source_product_name   varchar(512),
  source_brand          varchar(255),
  source_mrp_minor      bigint,
  source_price_minor    bigint,
  source_currency       char(3),
  source_rating         decimal(4,2),
  source_review_count   integer,
  source_availability   varchar(64),
  first_seen_date       date         NOT NULL,
  last_seen_date        date         NOT NULL,
  data_collection_date  date         NOT NULL,
  data_collection_method varchar(64) NOT NULL,
  data_confidence       decimal(5,2),
  -- how this record was tied to a master product
  match_status          varchar(32)  NOT NULL DEFAULT 'NO_CANDIDATE',
  match_score           decimal(5,2),
  match_rule            varchar(64),
  resolution            varchar(32)  NOT NULL DEFAULT 'PENDING_REVIEW',
  content_hash          varchar(64),
  normalized            json,
  raw_id                bigint,
  last_run_id           bigint,
  created_at            datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT product_source_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT product_source_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT product_source_raw_fk FOREIGN KEY (raw_id) REFERENCES pmd.raw_record (raw_id) ON DELETE SET NULL,
  CONSTRAINT product_source_run_fk FOREIGN KEY (last_run_id) REFERENCES pmd.ingestion_run (run_id),
  CONSTRAINT product_source_mrp_nonneg CHECK (source_mrp_minor IS NULL OR source_mrp_minor >= 0),
  CONSTRAINT product_source_price_nonneg CHECK (source_price_minor IS NULL OR source_price_minor >= 0),
  CONSTRAINT product_source_confidence_range CHECK (data_confidence IS NULL OR data_confidence BETWEEN 0 AND 100),
  CONSTRAINT product_source_match_status_values CHECK (match_status IN
    ('EXACT_MATCH','HIGH_CONFIDENCE','POSSIBLE_MATCH','DIFFERENT_PRODUCT','NEEDS_REVIEW','NO_CANDIDATE')),
  CONSTRAINT product_source_match_score_range CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 100),
  CONSTRAINT product_source_resolution_values CHECK (resolution IN
    ('LINKED_EXISTING','CREATED_NEW','PENDING_REVIEW','MANUAL_LINK')),
  UNIQUE KEY product_source_uq (source_id, source_product_id),
  KEY product_source_product_idx (product_id),
  KEY product_source_seen_idx (source_id, last_seen_date),
  KEY product_source_pending_idx (resolution)
);

-- PRODUCT_SELLER: current state of one seller's offer for one source listing.
CREATE TABLE pmd.product_offer (
  offer_id            bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_source_id   bigint       NOT NULL,
  product_id          bigint,
  source_id           smallint     NOT NULL,
  source_product_id   varchar(191) NOT NULL,
  seller_key          varchar(191) NOT NULL,                   -- seller_id, else lower(seller_name), else ''
  seller_id           varchar(191),
  seller_name         varchar(255),
  seller_location     varchar(255),
  seller_rating       decimal(4,2),
  price_minor         bigint,
  mrp_minor           bigint,
  discount_minor      bigint,
  discount_pct        decimal(6,2),
  currency            char(3)      NOT NULL DEFAULT 'INR',
  tax_inclusive       boolean,
  stock_status        varchar(16)  NOT NULL DEFAULT 'UNKNOWN',
  delivery_information text,
  source_url          text,
  first_seen_at       datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at        datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  collection_date     date         NOT NULL,
  collected_at        datetime(3)  NOT NULL,
  is_current          boolean      NOT NULL DEFAULT true,
  CONSTRAINT product_offer_psrc_fk FOREIGN KEY (product_source_id) REFERENCES pmd.product_source (product_source_id) ON DELETE CASCADE,
  CONSTRAINT product_offer_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT product_offer_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT product_offer_price_nonneg CHECK (price_minor IS NULL OR price_minor >= 0),
  CONSTRAINT product_offer_mrp_nonneg CHECK (mrp_minor IS NULL OR mrp_minor >= 0),
  CONSTRAINT product_offer_stock_values CHECK (stock_status IN ('IN_STOCK','OUT_OF_STOCK','LIMITED','UNKNOWN')),
  UNIQUE KEY product_offer_uq (product_source_id, seller_key),
  KEY product_offer_product_idx (product_id, is_current),
  KEY product_offer_source_seen_idx (source_id, last_seen_at)
);

-- PRODUCT_PRICE_HISTORY: append-only, one row per observed change (and per first sighting).
-- Range-partitioned by month so 100M+ rows stay prunable and old months can be archived.
--
-- NO FOREIGN KEYS, unlike the PostgreSQL original, which referenced
-- product_master, product_offer and source. MySQL rejects a foreign key on a
-- partitioned table outright ("Foreign keys are not yet supported in
-- conjunction with partitioning", ER_FOREIGN_KEY_ON_PARTITIONED / 1506), so the
-- choice was partitioning or referential integrity, not both. Partitioning won:
-- it is the reason this table has this shape, pruning and monthly archival are
-- what keep it workable at 100M rows, and the pipeline resolves all three ids
-- from the master immediately before it inserts here. The integrity of those
-- three columns is therefore the loader's responsibility — see
-- src/server/pmd/pipeline/load.ts.
--
-- AUTO_INCREMENT is permitted here, and is the first column of the primary key
-- as MySQL requires. MySQL also requires every unique key to contain every
-- partitioning column, which (price_history_id, collected_at) already did.
CREATE TABLE pmd.price_history (
  price_history_id  bigint       NOT NULL AUTO_INCREMENT,
  product_id        bigint       NOT NULL,
  offer_id          bigint,
  source_id         smallint     NOT NULL,
  seller_key        varchar(191) NOT NULL,
  seller_name       varchar(255),
  mrp_minor         bigint,
  selling_price_minor bigint,
  discount_minor    bigint,
  currency          char(3)      NOT NULL DEFAULT 'INR',
  stock_status      varchar(16)  NOT NULL DEFAULT 'UNKNOWN',
  change_reason     varchar(32)  NOT NULL DEFAULT 'FIRST_SEEN',
  collection_date   date         NOT NULL,
  collected_at      datetime(3)  NOT NULL,
  run_id            bigint,
  PRIMARY KEY (price_history_id, collected_at),
  CONSTRAINT price_history_reason_values CHECK (change_reason IN
    ('FIRST_SEEN','PRICE_CHANGED','MRP_CHANGED','STOCK_CHANGED','PRICE_AND_STOCK_CHANGED')),
  KEY price_history_product_idx (product_id, collected_at DESC),
  KEY price_history_offer_idx (offer_id, collected_at DESC)
  -- price_history_collected_brin is dropped: MySQL has no BRIN, and partition
  -- pruning on collected_at serves the access pattern BRIN was there for.
)
-- The DEFAULT partition becomes VALUES LESS THAN (MAXVALUE); MySQL has no
-- DEFAULT partition, and MAXVALUE catches everything beyond the last month.
-- The partition window is extended by splitting pmax with ALTER TABLE ...
-- REORGANIZE PARTITION, which is what the PostgreSQL function did by creating
-- a new child table.
PARTITION BY RANGE COLUMNS (collected_at) (
  PARTITION p2022_01 VALUES LESS THAN ('2022-02-01'),
  PARTITION pmax     VALUES LESS THAN (MAXVALUE)
);

-- ---------------------------------------------------------------------------
-- 9. IMAGES  (URLs only - images are never copied or redistributed)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.product_image (
  image_id           bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id         bigint       NOT NULL,
  `rank`             smallint     NOT NULL DEFAULT 0,          -- 0 = primary; `rank` is reserved in MySQL 8
  image_url          varchar(600) NOT NULL,
  image_source       varchar(191) NOT NULL,
  source_id          smallint,
  validation_status  varchar(16)  NOT NULL DEFAULT 'UNVALIDATED',
  license_note       text,
  checked_at         datetime(3),
  created_at         datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT product_image_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id) ON DELETE CASCADE,
  CONSTRAINT product_image_source_fk FOREIGN KEY (source_id) REFERENCES pmd.source (source_id),
  CONSTRAINT product_image_rank_range CHECK (`rank` BETWEEN 0 AND 20),
  CONSTRAINT product_image_validation_values CHECK (validation_status IN ('UNVALIDATED','VALID','BROKEN','RESTRICTED')),
  UNIQUE KEY product_image_uq (product_id, image_url)
);

-- ---------------------------------------------------------------------------
-- 10. MATCH REVIEW QUEUE, MERGES, CHANGE LOG
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.match_candidate (
  candidate_id          bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_source_id     bigint       NOT NULL,
  candidate_product_id  bigint       NOT NULL,
  match_score           decimal(5,2) NOT NULL,
  match_status          varchar(32)  NOT NULL,
  relation              varchar(40)  NOT NULL DEFAULT 'UNRELATED',
  reasons               json         NOT NULL DEFAULT ('{}'),
  hard_conflicts        json         NOT NULL DEFAULT ('[]'),   -- was text[]
  review_status         varchar(32)  NOT NULL DEFAULT 'PENDING',
  reviewed_by           varchar(36),                            -- was uuid
  reviewed_at           datetime(3),
  review_note           text,
  created_run_id        bigint,
  created_at            datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT match_candidate_psrc_fk FOREIGN KEY (product_source_id) REFERENCES pmd.product_source (product_source_id) ON DELETE CASCADE,
  CONSTRAINT match_candidate_product_fk FOREIGN KEY (candidate_product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT match_candidate_run_fk FOREIGN KEY (created_run_id) REFERENCES pmd.ingestion_run (run_id),
  CONSTRAINT match_candidate_score_range CHECK (match_score BETWEEN 0 AND 100),
  CONSTRAINT match_candidate_status_values CHECK (match_status IN
    ('EXACT_MATCH','HIGH_CONFIDENCE','POSSIBLE_MATCH','DIFFERENT_PRODUCT','NEEDS_REVIEW')),
  CONSTRAINT match_candidate_relation_values CHECK (relation IN
    ('SAME_PRODUCT','SAME_FAMILY_DIFFERENT_PACK','SAME_FAMILY_DIFFERENT_VARIANT','SAME_BRAND_DIFFERENT_PRODUCT','UNRELATED')),
  CONSTRAINT match_candidate_review_values CHECK (review_status IN
    ('PENDING','AUTO_LINKED','CONFIRMED_SAME','CONFIRMED_DIFFERENT','SAME_FAMILY')),
  UNIQUE KEY match_candidate_uq (product_source_id, candidate_product_id),
  KEY match_candidate_queue_idx (review_status, match_status),
  KEY match_candidate_product_idx (candidate_product_id)
);

CREATE TABLE pmd.product_merge_log (
  merge_id           bigint      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_product_id    bigint      NOT NULL,
  into_product_id    bigint      NOT NULL,
  reason             text,
  merged_by          varchar(191) NOT NULL,
  merged_at          datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT product_merge_log_from_fk FOREIGN KEY (from_product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT product_merge_log_into_fk FOREIGN KEY (into_product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT product_merge_log_distinct CHECK (from_product_id <> into_product_id)
);

-- VERSION HISTORY: every field the pipeline or a person changes on a master record.
CREATE TABLE pmd.product_change_log (
  change_id     bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id    bigint       NOT NULL,
  entity        varchar(32)  NOT NULL,          -- product_master | specification | identifier | image | status
  entity_key    varchar(191),
  field_name    varchar(191) NOT NULL,
  old_value     json,
  new_value     json,
  source_id     smallint,
  run_id        bigint,
  changed_by    varchar(191) NOT NULL DEFAULT 'system',
  changed_at    datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY product_change_log_product_idx (product_id, changed_at DESC)
);

-- ---------------------------------------------------------------------------
-- 11. BRIDGE TO THE LIVE MARKETPLACE CATALOGUE
-- ---------------------------------------------------------------------------
-- master product -> <app>.products (GOKESARI_PRODUCT_CATALOG) -> <app>.shop_products.
-- Shops pick an existing catalogue product; they never re-create it. Seller pricing is never copied here.
--
-- `@APP_DB@` is substituted by the migration runner with the application
-- database from DATABASE_URL. PostgreSQL wrote `public.products` because `pmd`
-- was a schema in the same database; in MySQL `pmd` is a database of its own, so
-- the reference has to name the other one — which is also why PMD has to live on
-- the same MySQL server as the application.
CREATE TABLE pmd.catalogue_link (
  product_id            bigint      NOT NULL PRIMARY KEY,
  catalogue_product_id  varchar(36) NOT NULL UNIQUE,            -- was uuid
  promoted_at           datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  promoted_by           varchar(36),                            -- was uuid
  promotion_note        text,
  CONSTRAINT catalogue_link_product_fk FOREIGN KEY (product_id) REFERENCES pmd.product_master (product_id),
  CONSTRAINT catalogue_link_catalogue_fk FOREIGN KEY (catalogue_product_id) REFERENCES `@APP_DB@`.products (id),
  CONSTRAINT catalogue_link_promoter_fk FOREIGN KEY (promoted_by) REFERENCES `@APP_DB@`.users (id)
);

-- ---------------------------------------------------------------------------
-- 12. WORK QUEUE  (FOR UPDATE SKIP LOCKED, which MySQL 8 also has)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.job (
  job_id        bigint       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_type      varchar(64)  NOT NULL,
  run_id        bigint,
  payload       json         NOT NULL DEFAULT ('{}'),
  status        varchar(16)  NOT NULL DEFAULT 'PENDING',
  priority      smallint     NOT NULL DEFAULT 5,
  attempts      smallint     NOT NULL DEFAULT 0,
  max_attempts  smallint     NOT NULL DEFAULT 5,
  run_after     datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by     varchar(191),
  locked_at     datetime(3),
  last_error    text,
  created_at    datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at   datetime(3),
  CONSTRAINT job_run_fk FOREIGN KEY (run_id) REFERENCES pmd.ingestion_run (run_id) ON DELETE CASCADE,
  CONSTRAINT job_status_values CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','DEAD')),
  -- the PostgreSQL index was partial (status = 'PENDING'); status leads here so
  -- the claim query still gets an index-ordered scan of the pending rows
  KEY job_claim_idx (status, priority, run_after, job_id)
);

-- pmd.claim_job() is gone: it was `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP
-- LOCKED) RETURNING j.*`, and MySQL has SKIP LOCKED but neither UPDATE ... FROM
-- nor RETURNING. The same three statements run inside one transaction instead.

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
  -- path_names[n] -> a JSON path; the array is a json column now
  JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[0]')) AS category_level_1,
  JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[1]')) AS category_level_2,
  JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[2]')) AS category_level_3,
  JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[3]')) AS category_level_4,
  JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[4]')) AS category_level_5,
  pf.family_name AS product_family
FROM pmd.product_master pm
LEFT JOIN pmd.brand          b  ON b.brand_id = pm.brand_id
LEFT JOIN pmd.manufacturer   m  ON m.manufacturer_id = pm.manufacturer_id
LEFT JOIN pmd.category       c  ON c.category_id = pm.category_id
LEFT JOIN pmd.product_family pf ON pf.family_id = pm.product_family_id;

-- Per-product price picture across current offers. Derived, never stored on the product.
CREATE VIEW pmd.v_product_price_summary AS
SELECT
  o.product_id,
  count(*)                                                              AS offer_count,
  count(CASE WHEN o.stock_status IN ('IN_STOCK','LIMITED') THEN 1 END)   AS in_stock_offer_count,
  min(o.price_minor)                                                    AS min_price_minor,
  max(o.price_minor)                                                    AS max_price_minor,
  CAST(round(avg(o.price_minor)) AS SIGNED)                             AS avg_price_minor,
  max(o.mrp_minor)                                                      AS max_mrp_minor,
  max(o.currency)                                                       AS currency,
  max(o.collected_at)                                                   AS last_collected_at
FROM pmd.product_offer o
WHERE o.is_current AND o.product_id IS NOT NULL
GROUP BY o.product_id;

-- ---------------------------------------------------------------------------
-- 14. QUALITY DASHBOARD SNAPSHOT  (refreshed after each run; reads stay O(1) at 10M rows)
-- ---------------------------------------------------------------------------
CREATE TABLE pmd.dashboard_metric (
  metric       varchar(64)   NOT NULL,
  dimension    varchar(191)  NOT NULL DEFAULT '',
  value        decimal(20,2) NOT NULL,
  computed_at  datetime(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (metric, dimension)
);

-- Serialises two runs that finish together, so they do not both rebuild the
-- dashboard snapshot at once. This replaces pg_advisory_xact_lock: MySQL's
-- GET_LOCK is session-scoped and would outlive the transaction, while a row
-- lock is released on commit or rollback — the lifetime the PostgreSQL version
-- had. Same reasoning as registration_locks in the application schema.
CREATE TABLE pmd.advisory_lock (
  name varchar(191) NOT NULL PRIMARY KEY
);

-- The reference data (sources, taxonomy, attribute registry, shipped category mappings) is defined in code.
-- The runner syncs it into the tables above only when its fingerprint differs from the one stored here -
-- NOT at the start of every run. (Re-upserting ~1,600 rows per run was slow over a network.)
CREATE TABLE pmd.reference_state (
  singleton    boolean      NOT NULL DEFAULT true PRIMARY KEY,
  content_hash varchar(64)  NOT NULL,
  applied_at   datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- CHECK (singleton) alone is rejected: MySQL wants a boolean expression,
  -- not a bare column reference
  CONSTRAINT reference_state_singleton CHECK (singleton = true)
);
