/**
 * Shared types for the Product Master Data Platform.
 *
 * Three shapes of a product flow through the pipeline, and keeping them apart is
 * what stops marketplace quirks leaking into the core engine:
 *
 *   RawRecord        what a source handed us, untouched
 *   StagedProduct    the source's fields renamed into one vocabulary (adapter's job)
 *   NormalizedProduct  canonical values, units, keys and issues (normalizer's job)
 */

export type SourceKind =
  | "MARKETPLACE"
  | "BRAND_MANUFACTURER"
  | "GOVERNMENT"
  | "OPEN_DATA"
  | "LICENSED_FEED"
  | "GS1"
  | "DISTRIBUTOR"
  | "INTERNAL";

export type AccessMethod =
  | "OFFICIAL_API"
  | "LICENSED_FEED"
  | "OPEN_DATASET"
  | "MANUFACTURER_FEED"
  | "PERMITTED_PUBLIC_PAGE"
  | "INTERNAL_DB"
  | "MANUAL_UPLOAD"
  | "NONE";

export type SourceStatus = "ACTIVE" | "PLANNED" | "BLOCKED_NEEDS_AGREEMENT" | "BLOCKED_TECHNICAL" | "DISABLED";

/** Static description of a source: one row of pmd.source, plus how to run it. */
/** How a supplier's file is read. Everything here can also be overridden on the command line. */
export interface FeedSettings {
  format?: "csv" | "xlsx";
  delimiter?: string;
  listSeparator?: string;
  /** xlsx: sheet name or 1-based position; default the first visible sheet. */
  sheet?: string | number;
  /** xlsx: 1-based heading row; default 1. */
  headerRow?: number;
  /** The supplier's category text (or GPC brick code) -> standard category code. */
  categoryMap?: Record<string, string>;
  restoreGtinZeros?: boolean;
  /** The file lists everything the supplier sells (only then may a run conclude "no longer listed"). */
  fullSnapshot?: boolean;
}

export interface SourceDefinition {
  key: string;
  name: string;
  kind: SourceKind;
  accessMethod: AccessMethod;
  status: SourceStatus;
  /** Defaults come from SOURCE_KIND_DEFAULTS when omitted. */
  reliability?: number;
  specPrecedence?: number;
  /** Why we are allowed to collect this. Required for every source, including blocked ones. */
  legalBasis: string;
  licenseName?: string;
  termsUrl?: string;
  robotsPolicy?: string;
  apiEndpoint?: string;
  /** NAME of the env var that holds credentials. The secret itself is never stored. */
  authEnvVar?: string;
  collectionFrequency?: string;
  rateLimitPerMin?: number;
  parserKey?: string;
  fieldMapping?: Record<string, string>;
  /** File-feed settings (format, sheet, delimiter, category map). Read by the feed importer; code-owned, not stored. */
  feed?: FeedSettings;
  retryMax?: number;
  notes?: string;
}

export interface RawRecord {
  /** The source's own identifier (ASIN, FSN, barcode, ...). */
  sourceProductId: string;
  payload: Record<string, unknown>;
  url?: string;
}

export interface StagedOffer {
  sellerId?: string | null;
  sellerName?: string | null;
  sellerLocation?: string | null;
  sellerRating?: number | string | null;
  /** Major currency units as the source reports them (e.g. 117.5 for INR), or a string. */
  price?: number | string | null;
  mrp?: number | string | null;
  currency?: string | null;
  stock?: string | null;
  deliveryInformation?: string | null;
  url?: string | null;
  collectedAt?: Date | string | null;
  taxInclusive?: boolean | null;
}

export interface StagedAttribute {
  key: string;
  value: string | number | boolean;
  unit?: string | null;
  /** Value exactly as the source wrote it, when normalisation changed it. */
  original?: string | null;
}

export interface StagedProduct {
  sourceProductId: string;
  sourceUrl?: string | null;
  name?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  /** Raw category strings/tags, most general first when the source orders them. */
  categories?: string[];
  description?: string | null;
  shortDescription?: string | null;
  gtin?: string | null;
  isbn?: string | null;
  mpn?: string | null;
  model?: string | null;
  sku?: string | null;
  productCode?: string | null;
  quantityText?: string | null;
  netWeightText?: string | null;
  grossWeightText?: string | null;
  dimensionsText?: string | null;
  color?: string | null;
  size?: string | null;
  material?: string | null;
  shape?: string | null;
  variant?: string | null;
  gstRate?: string | number | null;
  hsnCode?: string | number | null;
  cess?: string | number | null;
  countryOfOrigin?: string | null;
  /** Category-specific facts (nutrition, electronics specs, apparel fields...). */
  attributes?: StagedAttribute[];
  images?: string[];
  rating?: number | null;
  reviewCount?: number | null;
  availability?: string | null;
  offer?: StagedOffer | null;
  keywords?: string[];
  /** The source's own completeness/confidence for this record, 0-100, when it publishes one. */
  sourceConfidence?: number | null;
}

/* -------------------------------------------------------------- normalized */

export type IssueSeverity = "ERROR" | "WARNING" | "INFO";

export interface NormalizationIssue {
  field: string;
  code: string;
  severity: IssueSeverity;
  message: string;
  original?: string | null;
}

export type BaseUnit = "g" | "ml" | "pcs" | "mm";

export interface Quantity {
  /** Size of ONE unit, in the base unit (1 kg -> 1000 g). */
  unitValue: number;
  unit: BaseUnit;
  /** How many units are in the pack ("6 x 200 ml" -> 6). 1 for a single. */
  multiplier: number;
  /** unitValue * multiplier. */
  total: number;
  /** Canonical display: "500 g", "6 x 200 ml". */
  label: string;
  original: string;
}

export interface GtinInfo {
  /** Zero-padded GTIN-14: the one canonical form used for matching and storage. */
  gtin14: string;
  format: "GTIN-8" | "GTIN-12" | "GTIN-13" | "GTIN-14";
  original: string;
  checkDigitValid: boolean;
  /** Set for in-store / coupon / internal ranges. Such codes must never drive a match. */
  restricted?: "IN_STORE" | "COUPON" | "SERIAL" | "INTERNAL_USE";
  /** True when the code may be used as a global identity (valid check digit, not restricted). */
  usableForMatching: boolean;
  /** ISBN-13 digits when the code is in the 978/979 book range. */
  isbn13?: string;
}

export interface NamedEntity {
  /** Identity key (normalised, punctuation and legal suffixes removed). */
  key: string;
  /** Display name as first seen / cleaned. */
  display: string;
  original: string;
}

export interface NormalizedAttribute {
  key: string;
  valueText?: string;
  valueNum?: number;
  valueBool?: boolean;
  unit?: string;
  original?: string;
}

export interface NormalizedOffer {
  sellerId: string | null;
  sellerName: string | null;
  sellerLocation: string | null;
  sellerRating: number | null;
  /** Integer minor units (paise for INR). */
  priceMinor: number | null;
  mrpMinor: number | null;
  currency: string;
  stockStatus: "IN_STOCK" | "OUT_OF_STOCK" | "LIMITED" | "UNKNOWN";
  deliveryInformation: string | null;
  url: string | null;
  collectedAt: Date;
  taxInclusive: boolean | null;
  /** lower(seller id) | lower(seller name) | '' - identity of the seller within a listing. */
  sellerKey: string;
}

export interface NormalizedProduct {
  sourceProductId: string;
  sourceUrl: string | null;
  name: string;
  /** Name minus brand and pack tokens: what fuzzy matching compares. */
  coreName: string;
  /** brand + name + variant + model: what search runs against. */
  searchText: string;
  familyKey: string;
  brand: NamedEntity | null;
  otherBrands: string[];
  manufacturer: NamedEntity | null;
  gtin: GtinInfo | null;
  isbn13: string | null;
  mpn: { key: string; original: string } | null;
  model: { key: string; original: string } | null;
  sku: string | null;
  productCode: string | null;
  quantity: Quantity | null;
  netWeightG: number | null;
  grossWeightG: number | null;
  volumeMl: number | null;
  dimensionsMm: { length: number; width: number; height: number } | null;
  color: { key: string; display: string; family: string | null } | null;
  size: { key: string; display: string } | null;
  material: string | null;
  shape: string | null;
  variant: string | null;
  categoryRaw: string[];
  categoryCode: string | null;
  categoryConfidence: number | null;
  gstRateBp: number | null;
  hsnCode: string | null;
  cessBp: number | null;
  countryOfOrigin: string | null;
  description: string | null;
  shortDescription: string | null;
  attributes: NormalizedAttribute[];
  images: string[];
  rating: number | null;
  reviewCount: number | null;
  availability: string | null;
  offer: NormalizedOffer | null;
  keywords: string[];
  issues: NormalizationIssue[];
}

/* ------------------------------------------------------------------ match */

export type MatchStatus =
  | "EXACT_MATCH"
  | "HIGH_CONFIDENCE"
  | "POSSIBLE_MATCH"
  | "DIFFERENT_PRODUCT"
  | "NEEDS_REVIEW";

export type MatchRelation =
  | "SAME_PRODUCT"
  | "SAME_FAMILY_DIFFERENT_PACK"
  | "SAME_FAMILY_DIFFERENT_VARIANT"
  | "SAME_BRAND_DIFFERENT_PRODUCT"
  | "UNRELATED";

/** The comparable projection of a product - built from a NormalizedProduct or a master row. */
export interface MatchSubject {
  brandKey: string | null;
  gtin14: string | null;
  isbn13: string | null;
  mpnKey: string | null;
  modelKey: string | null;
  coreName: string;
  variant: string | null;
  colorKey: string | null;
  sizeKey: string | null;
  pack: { unitValue: number; unit: BaseUnit; multiplier: number } | null;
  categoryL1: string | null;
  dimensionsMm: { length: number; width: number; height: number } | null;
}

export interface MatchResult {
  /** 0-100. */
  score: number;
  status: MatchStatus;
  relation: MatchRelation;
  /** Which rule decided: L1_GTIN_BRAND, L1_MPN_BRAND, L2_BRAND_MPN_MODEL, L3_STRUCTURED, L4_FUZZY, ... */
  rule: string;
  /** Component scores 0-1 (or null when there was nothing to compare). Persisted for traceability. */
  components: Record<string, number | null>;
  /** Facts that forbid merging regardless of score: PACK_SIZE_DIFFERENT, COLOR_DIFFERENT, ... */
  hardConflicts: string[];
  /** Softer notes that capped the score: EXTRA_TOKENS, MISSING_PACK, ... */
  notes: string[];
}
