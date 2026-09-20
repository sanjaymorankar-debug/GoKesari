/** Brands, manufacturers, categories, and the data-quality dashboard read model. */
import type { Sql } from "../db";

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number) => Math.min(Math.max(n ?? dflt, lo), hi);

export async function listBrands(sql: Sql, opts: { q?: string; limit?: number; cursor?: string | null } = {}) {
  const limit = clamp(opts.limit, 1, 500, 100);
  const after = opts.cursor ? Number(opts.cursor) : 0;
  const q = opts.q?.trim();
  const rows = await sql<{ brand_id: number; brand_code: string; brand_name: string; brand_status: string; verification_status: string; country: string | null; manufacturer_name: string | null; product_count: number; aliases: string[] }[]>`
    SELECT b.brand_id, b.brand_code, b.brand_name, b.brand_status, b.verification_status, b.country, m.manufacturer_name,
           (SELECT count(*)::int FROM pmd.product_master p WHERE p.brand_id = b.brand_id AND p.record_status = 'ACTIVE') AS product_count,
           ARRAY(SELECT alias_original FROM pmd.brand_alias a WHERE a.brand_id = b.brand_id ORDER BY alias_original) AS aliases
    FROM pmd.brand b LEFT JOIN pmd.manufacturer m ON m.manufacturer_id = b.manufacturer_id
    WHERE b.brand_id > ${after} ${q ? sql`AND (b.brand_name ILIKE ${"%" + q + "%"} OR EXISTS (SELECT 1 FROM pmd.brand_alias a WHERE a.brand_id = b.brand_id AND a.alias_original ILIKE ${"%" + q + "%"}))` : sql``}
    ORDER BY b.brand_id LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    brandId: r.brand_code, name: r.brand_name, status: r.brand_status, verificationStatus: r.verification_status, country: r.country,
    manufacturer: r.manufacturer_name, productCount: r.product_count, aliases: r.aliases,
  }));
  return { items, nextCursor: more ? String(rows[limit - 1].brand_id) : null };
}

export async function listManufacturers(sql: Sql, opts: { q?: string; limit?: number; cursor?: string | null } = {}) {
  const limit = clamp(opts.limit, 1, 500, 100);
  const after = opts.cursor ? Number(opts.cursor) : 0;
  const q = opts.q?.trim();
  const rows = await sql<{ manufacturer_id: number; manufacturer_code: string; manufacturer_name: string; legal_name: string | null; country: string | null; gstin: string | null; website: string | null; verification_status: string; brand_count: number; aliases: string[] }[]>`
    SELECT m.manufacturer_id, m.manufacturer_code, m.manufacturer_name, m.legal_name, m.country, m.gstin, m.website, m.verification_status,
           (SELECT count(*)::int FROM pmd.brand b WHERE b.manufacturer_id = m.manufacturer_id) AS brand_count,
           ARRAY(SELECT alias_original FROM pmd.manufacturer_alias a WHERE a.manufacturer_id = m.manufacturer_id ORDER BY alias_original) AS aliases
    FROM pmd.manufacturer m WHERE m.manufacturer_id > ${after} ${q ? sql`AND m.manufacturer_name ILIKE ${"%" + q + "%"}` : sql``}
    ORDER BY m.manufacturer_id LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    manufacturerId: r.manufacturer_code, name: r.manufacturer_name, legalName: r.legal_name, country: r.country, gstin: r.gstin, website: r.website,
    verificationStatus: r.verification_status, brandCount: r.brand_count, aliases: r.aliases,
  }));
  return { items, nextCursor: more ? String(rows[limit - 1].manufacturer_id) : null };
}

/** The whole taxonomy (about 400 nodes) with live product counts per node. */
export async function listCategories(sql: Sql, opts: { level?: number; parent?: string } = {}) {
  const rows = await sql<{ category_id: number; category_code: string; level: number; name: string; path_names: string[]; gokesari_department: string | null; product_count: number }[]>`
    SELECT c.category_id, c.category_code, c.level, c.name, c.path_names, c.gokesari_department,
           (SELECT count(*)::int FROM pmd.product_master p WHERE p.category_id = c.category_id AND p.record_status = 'ACTIVE') AS product_count
    FROM pmd.category c
    WHERE c.is_active
      ${opts.level ? sql`AND c.level = ${opts.level}` : sql``}
      ${opts.parent ? sql`AND c.parent_id = (SELECT category_id FROM pmd.category WHERE category_code = ${opts.parent})` : sql``}
    ORDER BY c.sort_order`;
  return rows.map((r) => ({
    standardCategoryId: r.category_id, code: r.category_code, level: r.level, name: r.name, path: r.path_names,
    department: r.gokesari_department, productCount: r.product_count,
  }));
}

/* ------------------------------------------------------------- data quality */

export interface DataQualityReport {
  computedAt: string | null;
  windowDays: number;
  totals: Record<string, number>;
  byMarketplace: { source: string; count: number }[];
  byCategory: { category: string; count: number }[];
  byBrand: { brand: string; count: number }[];
  recentRuns: {
    runId: number; source: string; mode: string; status: string; startedAt: string; finishedAt: string | null;
    recordsRead: number; productsCreated: number; productsLinked: number; errorCount: number; reviewQueued: number;
  }[];
}

export async function getDataQualityReport(sql: Sql, opts: { refresh?: boolean } = {}): Promise<DataQualityReport> {
  let rows = opts.refresh ? [] : await sql<{ metric: string; dimension: string; value: number; computed_at: Date }[]>`SELECT metric, dimension, value, computed_at FROM pmd.dashboard_metric`;
  if (rows.length === 0) {
    await sql`SELECT pmd.refresh_dashboard()`;
    rows = await sql<{ metric: string; dimension: string; value: number; computed_at: Date }[]>`SELECT metric, dimension, value, computed_at FROM pmd.dashboard_metric`;
  }
  const totals: Record<string, number> = {};
  const dims = { by_marketplace: [] as [string, number][], by_category: [] as [string, number][], by_brand: [] as [string, number][] };
  for (const r of rows) {
    if (r.dimension === "") totals[r.metric] = r.value;
    else if (r.metric in dims) dims[r.metric as keyof typeof dims].push([r.dimension, r.value]);
  }
  const sorted = (a: [string, number][]) => a.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const runs = await sql<{ run_id: number; source_key: string; run_mode: string; status: string; started_at: Date; finished_at: Date | null; records_read: number; products_created: number; products_linked: number; error_count: number; review_queued: number }[]>`
    SELECT r.run_id, s.source_key, r.run_mode, r.status, r.started_at, r.finished_at, r.records_read, r.products_created, r.products_linked, r.error_count, r.review_queued
    FROM pmd.ingestion_run r JOIN pmd.source s USING (source_id) ORDER BY r.run_id DESC LIMIT 10`;
  return {
    computedAt: rows[0]?.computed_at?.toISOString() ?? null,
    windowDays: 7,
    totals,
    byMarketplace: sorted(dims.by_marketplace).map(([source, count]) => ({ source, count })),
    byCategory: sorted(dims.by_category).map(([category, count]) => ({ category, count })),
    byBrand: sorted(dims.by_brand).slice(0, 25).map(([brand, count]) => ({ brand, count })),
    recentRuns: runs.map((r) => ({
      runId: r.run_id, source: r.source_key, mode: r.run_mode, status: r.status, startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null, recordsRead: r.records_read, productsCreated: r.products_created,
      productsLinked: r.products_linked, errorCount: r.error_count, reviewQueued: r.review_queued,
    })),
  };
}

/* --------------------------------------------------------------- review queue */

export interface ReviewItem {
  candidateId: number;
  matchScore: number;
  matchStatus: string;
  relation: string;
  rule: string | null;
  hardConflicts: string[];
  incoming: { source: string; sourceProductId: string; name: string | null; brand: string | null; masterProductId: string | null };
  candidate: { masterProductId: string; name: string; brand: string | null; packSize: string | null };
}

interface ReviewRow {
  candidate_id: number;
  match_score: number;
  match_status: string;
  relation: string;
  rule: string | null;
  hard_conflicts: string[] | null;
  source_key: string;
  source_product_id: string;
  source_product_name: string | null;
  source_brand: string | null;
  incoming_master: string | null;
  candidate_master: string;
  candidate_name: string;
  candidate_brand: string | null;
  candidate_pack: string | null;
}

export async function listReviewQueue(sql: Sql, opts: { limit?: number; cursor?: string | null } = {}): Promise<{ items: ReviewItem[]; nextCursor: string | null }> {
  const limit = clamp(opts.limit, 1, 200, 50);
  const after = opts.cursor ? Number(opts.cursor) : 0;
  const rows = await sql<ReviewRow[]>`
    SELECT mc.candidate_id, mc.match_score, mc.match_status, mc.relation, mc.reasons ->> 'rule' AS rule, mc.hard_conflicts,
           s.source_key, ps.source_product_id, ps.source_product_name, ps.source_brand, own.master_product_id AS incoming_master,
           cm.master_product_id AS candidate_master, cm.product_name AS candidate_name, cb.brand_name AS candidate_brand, cm.pack_size AS candidate_pack
    FROM pmd.match_candidate mc
    JOIN pmd.product_source ps USING (product_source_id)
    JOIN pmd.source s ON s.source_id = ps.source_id
    LEFT JOIN pmd.product_master own ON own.product_id = ps.product_id
    JOIN pmd.product_master cm ON cm.product_id = mc.candidate_product_id
    LEFT JOIN pmd.brand cb ON cb.brand_id = cm.brand_id
    WHERE mc.review_status = 'PENDING' AND mc.candidate_id > ${after}
    ORDER BY mc.candidate_id LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    candidateId: r.candidate_id, matchScore: r.match_score, matchStatus: r.match_status, relation: r.relation, rule: r.rule, hardConflicts: r.hard_conflicts ?? [],
    incoming: { source: r.source_key, sourceProductId: r.source_product_id, name: r.source_product_name, brand: r.source_brand, masterProductId: r.incoming_master },
    candidate: { masterProductId: r.candidate_master, name: r.candidate_name, brand: r.candidate_brand, packSize: r.candidate_pack },
  }));
  return { items, nextCursor: more ? String(rows[limit - 1].candidate_id) : null };
}
