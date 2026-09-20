/**
 * Read model for the product master: listing, search, detail, offers, price history.
 *
 * Everything here is read-only and index-backed. Lists use KEYSET pagination on
 * product_id (never OFFSET), so page 1,000,000 costs the same as page 1 at 10M rows.
 */
import type { Sql } from "../db";
import { analyzeGtin, normalizeAlnumKey } from "../normalize/identifiers";
import { normalizeText, tokenize } from "../normalize/text";

export interface ProductFilters {
  brand?: string;
  manufacturer?: string;
  /** Category slug path, e.g. "dairy/milk". Includes everything beneath it. */
  category?: string;
  status?: string;
  minQuality?: number;
  hasGtin?: boolean;
}

export interface ProductSummary {
  masterProductId: string;
  productName: string;
  brand: string | null;
  manufacturer: string | null;
  categoryPath: string[] | null;
  gtin: string | null;
  packSize: string | null;
  productStatus: string;
  dataQualityScore: number | null;
  offerCount: number;
  minPriceMinor: number | null;
  currency: string | null;
  sourceCount: number;
}

interface SummaryRow {
  product_id: number;
  master_product_id: string;
  product_name: string;
  brand_name: string | null;
  manufacturer_name: string | null;
  category_path: string[] | null;
  gtin: string | null;
  pack_size: string | null;
  product_status: string;
  data_quality_score: number | null;
  offer_count: number | null;
  min_price_minor: number | null;
  currency: string | null;
  source_count: number;
  rank?: number;
  match_type?: string;
}

const toSummary = (r: SummaryRow): ProductSummary => ({
  masterProductId: r.master_product_id,
  productName: r.product_name,
  brand: r.brand_name,
  manufacturer: r.manufacturer_name,
  categoryPath: r.category_path,
  gtin: r.gtin,
  packSize: r.pack_size,
  productStatus: r.product_status,
  dataQualityScore: r.data_quality_score,
  offerCount: r.offer_count ?? 0,
  minPriceMinor: r.min_price_minor,
  currency: r.currency,
  sourceCount: r.source_count,
});

const SUMMARY_SELECT = (sql: Sql) => sql`
  pm.product_id, pm.master_product_id, pm.product_name, b.brand_name, m.manufacturer_name, c.path_names AS category_path,
  pm.gtin, pm.pack_size, pm.product_status, pm.data_quality_score, ps.offer_count, ps.min_price_minor, ps.currency,
  (SELECT count(*)::int FROM pmd.product_source x WHERE x.product_id = pm.product_id) AS source_count`;

const SUMMARY_FROM = (sql: Sql) => sql`
  FROM pmd.product_master pm
  LEFT JOIN pmd.brand b ON b.brand_id = pm.brand_id
  LEFT JOIN pmd.manufacturer m ON m.manufacturer_id = pm.manufacturer_id
  LEFT JOIN pmd.category c ON c.category_id = pm.category_id
  LEFT JOIN pmd.v_product_price_summary ps ON ps.product_id = pm.product_id`;

function filterFragments(sql: Sql, f: ProductFilters) {
  return [
    f.brand ? sql`AND pm.brand_id = (SELECT brand_id FROM pmd.brand WHERE brand_code = ${f.brand})` : sql``,
    f.manufacturer ? sql`AND pm.manufacturer_id = (SELECT manufacturer_id FROM pmd.manufacturer WHERE manufacturer_code = ${f.manufacturer})` : sql``,
    f.category
      ? sql`AND pm.category_id IN (SELECT category_id FROM pmd.category WHERE (SELECT category_id FROM pmd.category WHERE category_code = ${f.category}) = ANY(path_ids))`
      : sql``,
    f.status ? sql`AND pm.product_status = ${f.status}` : sql``,
    f.minQuality != null ? sql`AND pm.data_quality_score >= ${f.minQuality}` : sql``,
    f.hasGtin === true ? sql`AND pm.gtin IS NOT NULL` : f.hasGtin === false ? sql`AND pm.gtin IS NULL` : sql``,
  ];
}

export async function listProducts(
  sql: Sql,
  filters: ProductFilters,
  page: { limit?: number; cursor?: string | null } = {},
): Promise<{ items: ProductSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const after = page.cursor ? Number(page.cursor) : 0;
  const [f1, f2, f3, f4, f5, f6] = filterFragments(sql, filters);
  const rows = await sql<SummaryRow[]>`
    SELECT ${SUMMARY_SELECT(sql)} ${SUMMARY_FROM(sql)}
    WHERE pm.record_status = 'ACTIVE' AND pm.product_id > ${Number.isFinite(after) ? after : 0}
      ${f1} ${f2} ${f3} ${f4} ${f5} ${f6}
    ORDER BY pm.product_id LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items: items.map(toSummary), nextCursor: more ? String(items[items.length - 1].product_id) : null };
}

/* ------------------------------------------------------------------ search */

export type SearchMatchType = "IDENTIFIER" | "KEYWORD" | "FUZZY";

export interface SearchHit extends ProductSummary {
  matchType: SearchMatchType;
  score: number;
}

/**
 * Multi-field search: GTIN/EAN/UPC/ISBN and MPN/model/SKU are exact identifier lookups
 * first; then keyword search over brand + name + variant + model (all terms must appear,
 * the last term matches as a prefix); then fuzzy trigram search to forgive typos.
 * "Samsung 55 inch 4K TV" finds the same product however each source titled it.
 */
export async function searchProducts(
  sql: Sql,
  query: string,
  filters: ProductFilters = {},
  limit = 25,
): Promise<{ query: string; items: SearchHit[] }> {
  const q = query.trim();
  const max = Math.min(Math.max(limit, 1), 100);
  if (!q) return { query: q, items: [] };
  const [f1, f2, f3, f4, f5, f6] = filterFragments(sql, filters);
  const seen = new Map<number, SearchHit>();
  const add = (rows: SummaryRow[], type: SearchMatchType, base: number) => {
    for (const r of rows) {
      if (!seen.has(r.product_id)) seen.set(r.product_id, { ...toSummary(r), matchType: type, score: Math.round((base + (r.rank ?? 0)) * 1000) / 1000 });
    }
  };

  // 1. identifiers
  const gtin = analyzeGtin(q);
  const key = normalizeAlnumKey(q);
  if (gtin || key) {
    const rows = await sql<SummaryRow[]>`
      SELECT DISTINCT ${SUMMARY_SELECT(sql)} ${SUMMARY_FROM(sql)}
      JOIN pmd.product_identifier i ON i.product_id = pm.product_id
      WHERE pm.record_status = 'ACTIVE' ${f1} ${f2} ${f3} ${f4} ${f5} ${f6}
        AND ((i.id_type IN ('GTIN','ISBN') AND i.id_value = ANY(${[gtin?.gtin14 ?? "", gtin?.isbn13 ?? ""]}))
          OR (i.id_type IN ('MPN','MODEL','SKU','PRODUCT_CODE') AND i.id_value = ${key?.key ?? ""}))
      LIMIT ${max}`;
    add(rows, "IDENTIFIER", 100);
  }

  // 2. keywords: every term, last as prefix (uses the GIN full-text index)
  const tokens = tokenize(q).filter((t) => /^[\p{L}\p{N}.%]+$/u.test(t));
  if (tokens.length && seen.size < max) {
    const tsquery = tokens.map((t, i) => `${t.replace(/[':&|!()<>]/g, "")}${i === tokens.length - 1 ? ":*" : ""}`).filter(Boolean).join(" & ");
    if (tsquery) {
      const rows = await sql<SummaryRow[]>`
        SELECT ${SUMMARY_SELECT(sql)}, ts_rank(to_tsvector('simple', pm.search_text), to_tsquery('simple', ${tsquery})) AS rank
        ${SUMMARY_FROM(sql)}
        WHERE pm.record_status = 'ACTIVE' ${f1} ${f2} ${f3} ${f4} ${f5} ${f6}
          AND to_tsvector('simple', pm.search_text) @@ to_tsquery('simple', ${tsquery})
        ORDER BY rank DESC, pm.data_quality_score DESC NULLS LAST LIMIT ${max}`;
      add(rows, "KEYWORD", 50);
    }
  }

  // 3. fuzzy: forgives typos and spelling variants (uses the GIN trigram index)
  if (seen.size < max) {
    const norm = normalizeText(q);
    if (norm.length >= 3) {
      const out = await sql.begin("read only", async (tx) => {
        await tx`SELECT set_config('pg_trgm.similarity_threshold', '0.3', true)`;
        return tx<SummaryRow[]>`
          SELECT ${SUMMARY_SELECT(tx as unknown as Sql)}, similarity(pm.search_text, ${norm}) AS rank
          ${SUMMARY_FROM(tx as unknown as Sql)}
          WHERE pm.record_status = 'ACTIVE' ${f1} ${f2} ${f3} ${f4} ${f5} ${f6} AND pm.search_text % ${norm}
          ORDER BY rank DESC LIMIT ${max}`;
      });
      add(out, "FUZZY", 0);
    }
  }
  const items = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max);
  return { query: q, items };
}

/* ------------------------------------------------------------------ detail */

export interface ProductDetail {
  masterProductId: string;
  productName: string;
  recordStatus: string;
  productStatus: string;
  statusBasis: string | null;
  brand: { code: string; name: string } | null;
  manufacturer: { code: string; name: string } | null;
  category: { code: string; path: string[] } | null;
  family: { name: string; members: { masterProductId: string; productName: string; packSize: string | null }[] } | null;
  identifiers: { type: string; value: string; original: string; format: string | null; primary: boolean; checkDigitValid: boolean | null }[];
  attributes: Record<string, unknown>;
  specifications: { key: string; label: string; group: string; value: string | number | boolean | null; unit: string | null; source: string; preferred: boolean; confidence: number | null }[];
  sources: { source: string; sourceProductId: string; url: string | null; method: string; matchStatus: string; matchScore: number | null; lastSeen: string }[];
  images: { rank: number; url: string; source: string; validation: string }[];
  conflicts: { attribute: string; value1: string; source1: string; value2: string; source2: string; status: string; resolution: string | null }[];
  quality: { score: number | null; components: unknown; computedAt: Date | null };
  offerSummary: { offerCount: number; minPriceMinor: number | null; maxPriceMinor: number | null; currency: string | null };
  catalogue: { catalogueProductId: string; code: string; promotedAt: Date } | null;
  pendingReviewItems: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  version: number;
}

export async function getProduct(sql: Sql, masterProductId: string): Promise<ProductDetail | null> {
  const [pm] = await sql<Record<string, unknown>[]>`
    SELECT pm.*, b.brand_code, b.brand_name, m.manufacturer_code, m.manufacturer_name, c.category_code, c.path_names AS category_path,
           pf.family_name
    FROM pmd.product_master pm
    LEFT JOIN pmd.brand b ON b.brand_id = pm.brand_id
    LEFT JOIN pmd.manufacturer m ON m.manufacturer_id = pm.manufacturer_id
    LEFT JOIN pmd.category c ON c.category_id = pm.category_id
    LEFT JOIN pmd.product_family pf ON pf.family_id = pm.product_family_id
    WHERE pm.master_product_id = ${masterProductId}`;
  if (!pm) return null;
  const id = pm.product_id as number;

  const [identifiers, specs, sources, images, conflicts, family, offer, link, pending] = await Promise.all([
    sql<{ id_type: string; id_value: string; id_value_original: string; id_format: string | null; is_primary: boolean; check_digit_valid: boolean | null }[]>`
      SELECT id_type, id_value, id_value_original, id_format, is_primary, check_digit_valid FROM pmd.product_identifier WHERE product_id = ${id} ORDER BY is_primary DESC, id_type`,
    sql<{ attribute_key: string; attribute_label: string; attribute_group: string; value_text: string | null; value_num: number | null; value_bool: boolean | null; unit: string | null; source_key: string; is_preferred: boolean; confidence: number | null }[]>`
      SELECT sp.attribute_key, ad.attribute_label, ad.attribute_group, sp.value_text, sp.value_num, sp.value_bool, sp.unit, s.source_key, sp.is_preferred, sp.confidence
      FROM pmd.product_specification sp JOIN pmd.attribute_definition ad USING (attribute_key) JOIN pmd.source s USING (source_id)
      WHERE sp.product_id = ${id} ORDER BY ad.sort_order, sp.attribute_key, s.source_key`,
    sql<{ source_key: string; source_product_id: string; source_url: string | null; data_collection_method: string; match_status: string; match_score: number | null; last_seen_date: string }[]>`
      SELECT s.source_key, ps.source_product_id, ps.source_url, ps.data_collection_method, ps.match_status, ps.match_score, ps.last_seen_date
      FROM pmd.product_source ps JOIN pmd.source s USING (source_id) WHERE ps.product_id = ${id} ORDER BY s.source_key`,
    sql<{ rank: number; image_url: string; image_source: string; validation_status: string }[]>`SELECT rank, image_url, image_source, validation_status FROM pmd.product_image WHERE product_id = ${id} ORDER BY rank`,
    sql<{ attribute_key: string; value_1: string; source_1: string; value_2: string; source_2: string; conflict_status: string; resolution: string | null }[]>`
      SELECT attribute_key, value_1, source_1, value_2, source_2, conflict_status, resolution FROM pmd.product_attribute_conflict WHERE product_id = ${id} ORDER BY conflict_id`,
    pm.product_family_id
      ? sql<{ master_product_id: string; product_name: string; pack_size: string | null }[]>`
          SELECT master_product_id, product_name, pack_size FROM pmd.product_master WHERE product_family_id = ${pm.product_family_id as number} AND record_status = 'ACTIVE' ORDER BY net_quantity_value NULLS LAST, product_id LIMIT 50`
      : Promise.resolve([]),
    sql<{ offer_count: number; min_price_minor: number | null; max_price_minor: number | null; currency: string | null }[]>`SELECT offer_count, min_price_minor, max_price_minor, currency FROM pmd.v_product_price_summary WHERE product_id = ${id}`,
    sql<{ catalogue_product_id: string; code: string; promoted_at: Date }[]>`
      SELECT cl.catalogue_product_id, p.code, cl.promoted_at FROM pmd.catalogue_link cl JOIN public.products p ON p.id = cl.catalogue_product_id WHERE cl.product_id = ${id}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.match_candidate mc JOIN pmd.product_source ps USING (product_source_id) WHERE ps.product_id = ${id} AND mc.review_status = 'PENDING'`,
  ]);

  const p = pm as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const attributes: Record<string, unknown> = {};
  for (const k of ["net_weight_g", "gross_weight_g", "length_mm", "width_mm", "height_mm", "volume_ml", "net_quantity_value", "net_quantity_unit", "pack_size", "pack_count", "unit_count", "material", "color", "size", "shape", "gst_rate_bp", "hsn_code", "cess_bp", "variant_name", "model_number", "mpn", "sku", "product_code", "short_description", "long_description"]) {
    if (p[k] != null) attributes[k] = p[k];
  }
  return {
    masterProductId: p.master_product_id,
    productName: p.product_name,
    recordStatus: p.record_status,
    productStatus: p.product_status,
    statusBasis: p.status_basis,
    brand: p.brand_code ? { code: p.brand_code, name: p.brand_name } : null,
    manufacturer: p.manufacturer_code ? { code: p.manufacturer_code, name: p.manufacturer_name } : null,
    category: p.category_code ? { code: p.category_code, path: p.category_path } : null,
    family: p.family_name ? { name: p.family_name, members: family.map((f) => ({ masterProductId: f.master_product_id, productName: f.product_name, packSize: f.pack_size })) } : null,
    identifiers: identifiers.map((i) => ({ type: i.id_type, value: i.id_value, original: i.id_value_original, format: i.id_format, primary: i.is_primary, checkDigitValid: i.check_digit_valid })),
    attributes,
    specifications: specs.map((s) => ({
      key: s.attribute_key, label: s.attribute_label, group: s.attribute_group, unit: s.unit, source: s.source_key, preferred: s.is_preferred, confidence: s.confidence,
      value: s.value_num ?? s.value_bool ?? s.value_text,
    })),
    sources: sources.map((s) => ({ source: s.source_key, sourceProductId: s.source_product_id, url: s.source_url, method: s.data_collection_method, matchStatus: s.match_status, matchScore: s.match_score, lastSeen: s.last_seen_date })),
    images: images.map((i) => ({ rank: i.rank, url: i.image_url, source: i.image_source, validation: i.validation_status })),
    conflicts: conflicts.map((c) => ({ attribute: c.attribute_key, value1: c.value_1, source1: c.source_1, value2: c.value_2, source2: c.source_2, status: c.conflict_status, resolution: c.resolution })),
    quality: { score: p.data_quality_score, components: p.quality_components, computedAt: p.quality_computed_at },
    offerSummary: { offerCount: offer[0]?.offer_count ?? 0, minPriceMinor: offer[0]?.min_price_minor ?? null, maxPriceMinor: offer[0]?.max_price_minor ?? null, currency: offer[0]?.currency ?? null },
    catalogue: link[0] ? { catalogueProductId: link[0].catalogue_product_id, code: link[0].code, promotedAt: link[0].promoted_at } : null,
    pendingReviewItems: pending[0]?.n ?? 0,
    firstSeenAt: p.first_seen_at,
    lastSeenAt: p.last_seen_at,
    version: p.version,
  };
}

/* ------------------------------------------------------------ offers, prices */

export interface OfferView {
  source: string;
  sourceProductId: string;
  sellerId: string | null;
  sellerName: string | null;
  sellerLocation: string | null;
  sellerRating: number | null;
  priceMinor: number | null;
  mrpMinor: number | null;
  discountMinor: number | null;
  discountPct: number | null;
  currency: string;
  taxInclusive: boolean | null;
  stockStatus: string;
  deliveryInformation: string | null;
  sourceUrl: string | null;
  collectionDate: string;
  collectedAt: Date;
  isCurrent: boolean;
}

interface OfferRow {
  source: string;
  source_product_id: string;
  seller_id: string | null;
  seller_name: string | null;
  seller_location: string | null;
  seller_rating: number | null;
  price_minor: number | null;
  mrp_minor: number | null;
  discount_minor: number | null;
  discount_pct: number | null;
  currency: string;
  tax_inclusive: boolean | null;
  stock_status: string;
  delivery_information: string | null;
  source_url: string | null;
  collection_date: string;
  collected_at: Date;
  is_current: boolean;
}

export async function getOffers(sql: Sql, masterProductId: string, opts: { currentOnly?: boolean } = {}): Promise<OfferView[]> {
  const rows = await sql<OfferRow[]>`
    SELECT s.source_key AS source, o.source_product_id, o.seller_id, o.seller_name, o.seller_location, o.seller_rating, o.price_minor, o.mrp_minor,
           o.discount_minor, o.discount_pct, o.currency, o.tax_inclusive, o.stock_status, o.delivery_information, o.source_url,
           o.collection_date, o.collected_at, o.is_current
    FROM pmd.product_offer o
    JOIN pmd.product_master pm ON pm.product_id = o.product_id
    JOIN pmd.source s ON s.source_id = o.source_id
    WHERE pm.master_product_id = ${masterProductId} ${opts.currentOnly ? sql`AND o.is_current` : sql``}
    ORDER BY o.price_minor NULLS LAST, s.source_key, o.seller_key`;
  return rows.map((r) => ({
    source: r.source, sourceProductId: r.source_product_id, sellerId: r.seller_id, sellerName: r.seller_name, sellerLocation: r.seller_location,
    sellerRating: r.seller_rating, priceMinor: r.price_minor, mrpMinor: r.mrp_minor, discountMinor: r.discount_minor, discountPct: r.discount_pct,
    currency: r.currency, taxInclusive: r.tax_inclusive, stockStatus: r.stock_status, deliveryInformation: r.delivery_information,
    sourceUrl: r.source_url, collectionDate: r.collection_date, collectedAt: r.collected_at, isCurrent: r.is_current,
  }));
}

export interface PricePointView {
  source: string;
  seller: string | null;
  mrpMinor: number | null;
  sellingPriceMinor: number | null;
  discountMinor: number | null;
  currency: string;
  stockStatus: string;
  changeReason: string;
  collectionDate: string;
  collectedAt: Date;
}

export async function getPriceHistory(
  sql: Sql,
  masterProductId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<{
  summary: { observations: number; lowestMinor: number | null; highestMinor: number | null; averageMinor: number | null };
  points: PricePointView[];
}> {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  const rows = await sql<{
    source: string; seller: string | null; mrp_minor: number | null; selling_price_minor: number | null; discount_minor: number | null;
    currency: string; stock_status: string; change_reason: string; collection_date: string; collected_at: Date;
  }[]>`
    SELECT s.source_key AS source, h.seller_name AS seller, h.mrp_minor, h.selling_price_minor, h.discount_minor, h.currency, h.stock_status,
           h.change_reason, h.collection_date, h.collected_at
    FROM pmd.price_history h
    JOIN pmd.product_master pm ON pm.product_id = h.product_id
    JOIN pmd.source s ON s.source_id = h.source_id
    WHERE pm.master_product_id = ${masterProductId}
      ${opts.from ? sql`AND h.collected_at >= ${opts.from}::date` : sql``}
      ${opts.to ? sql`AND h.collected_at < (${opts.to}::date + 1)` : sql``}
    ORDER BY h.collected_at, h.price_history_id LIMIT ${limit}`;
  const points: PricePointView[] = rows.map((r) => ({
    source: r.source, seller: r.seller, mrpMinor: r.mrp_minor, sellingPriceMinor: r.selling_price_minor, discountMinor: r.discount_minor,
    currency: r.currency, stockStatus: r.stock_status, changeReason: r.change_reason, collectionDate: r.collection_date, collectedAt: r.collected_at,
  }));
  const prices = points.map((p) => p.sellingPriceMinor).filter((n): n is number => n != null);
  const summary = prices.length
    ? { observations: prices.length, lowestMinor: Math.min(...prices), highestMinor: Math.max(...prices), averageMinor: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) }
    : { observations: 0, lowestMinor: null, highestMinor: null, averageMinor: null };
  return { summary, points };
}
