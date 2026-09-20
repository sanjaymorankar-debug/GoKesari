/**
 * Candidate retrieval + matching against the master.
 *
 * Comparing an incoming record to every master would be O(n) and impossible at 10M
 * products. Retrieval is BLOCKING: only masters that share a strong signal are
 * scored, and every retrieval query is index-backed:
 *
 *   1. identifier   GTIN / ISBN            unique index on product_identifier
 *   2. MPN          brand-scoped           index on product_identifier
 *   3. brand+model  brand-scoped           index on product_identifier
 *   4. siblings     brand + identical core btree (brand_id, normalized_name)
 *   5. fuzzy        brand + trigram         GIN gin_trgm_ops on normalized_name
 *   6. keyword      no brand: trigram on search_text, stricter threshold
 *
 * The scorer (score.ts) then decides; nothing here merges anything.
 */
import type { PmdConfig } from "../config";
import type { Queryable } from "../db";
import { normalizeColor, normalizeSize } from "../normalize/attributes";
import { normalizeAlnumKey } from "../normalize/identifiers";
import { tokenize } from "../normalize/text";
import type { MatchSubject, NormalizedProduct } from "../types";
import { categoryL1FromCode, decide, scoreMatch, subjectFromNormalized, type MatchDecision, type ScoredCandidate } from "./score";

export interface MasterRow {
  product_id: number;
  brand_id: number | null;
  brand_key: string | null;
  gtin: string | null;
  isbn: string | null;
  mpn: string | null;
  model_number: string | null;
  normalized_name: string;
  variant_name: string | null;
  color: string | null;
  size: string | null;
  net_quantity_value: number | null;
  net_quantity_unit: "g" | "ml" | "pcs" | "mm" | null;
  pack_count: number | null;
  category_code: string | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
}

export function subjectFromMasterRow(r: MasterRow): MatchSubject {
  const dims = r.length_mm != null && r.width_mm != null && r.height_mm != null
    ? { length: r.length_mm, width: r.width_mm, height: r.height_mm }
    : null;
  return {
    brandKey: r.brand_key,
    gtin14: r.gtin,
    isbn13: r.isbn,
    mpnKey: normalizeAlnumKey(r.mpn)?.key ?? null,
    modelKey: normalizeAlnumKey(r.model_number)?.key ?? null,
    coreName: r.normalized_name,
    variant: r.variant_name ? tokenize(r.variant_name).join(" ") : null,
    colorKey: normalizeColor(r.color)?.key ?? null,
    sizeKey: normalizeSize(r.size)?.key ?? null,
    pack:
      r.net_quantity_value != null && r.net_quantity_unit
        ? { unitValue: r.net_quantity_value, unit: r.net_quantity_unit, multiplier: r.pack_count ?? 1 }
        : null,
    categoryL1: categoryL1FromCode(r.category_code),
    dimensionsMm: dims,
  };
}

export async function loadMasterRows(sql: Queryable, ids: number[]): Promise<MasterRow[]> {
  if (ids.length === 0) return [];
  return sql<MasterRow[]>`
    SELECT pm.product_id, pm.brand_id, b.brand_key, pm.gtin, pm.isbn, pm.mpn, pm.model_number, pm.normalized_name,
           pm.variant_name, pm.color, pm.size, pm.net_quantity_value, pm.net_quantity_unit, pm.pack_count,
           c.category_code, pm.length_mm, pm.width_mm, pm.height_mm
    FROM pmd.product_master pm
    LEFT JOIN pmd.brand b ON b.brand_id = pm.brand_id
    LEFT JOIN pmd.category c ON c.category_id = pm.category_id
    WHERE pm.product_id IN ${sql(ids)} AND pm.record_status = 'ACTIVE'`;
}

/** Returns candidate master ids for one incoming record. Index-backed, bounded, no full scans. */
export async function findCandidateIds(
  sql: Queryable,
  n: NormalizedProduct,
  brandId: number | null,
  cfg: PmdConfig,
): Promise<number[]> {
  const ids = new Set<number>();
  const add = (rows: { product_id: number }[]) => rows.forEach((r) => ids.add(r.product_id));
  const max = cfg.match.maxCandidates;

  // 1. identifiers (unique-indexed)
  if (n.gtin?.usableForMatching) {
    add(await sql`
      SELECT i.product_id FROM pmd.product_identifier i
      JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
      WHERE i.id_type = 'GTIN' AND i.id_value = ${n.gtin.gtin14}`);
  }
  if (n.isbn13) {
    add(await sql`
      SELECT i.product_id FROM pmd.product_identifier i
      JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
      WHERE i.id_type = 'ISBN' AND i.id_value = ${n.isbn13}`);
  }

  // 2 + 3. MPN and model, scoped to the brand when we know it
  for (const [type, key] of [["MPN", n.mpn?.key], ["MODEL", n.model?.key]] as const) {
    if (!key) continue;
    add(
      brandId != null
        ? await sql`
            SELECT DISTINCT i.product_id FROM pmd.product_identifier i
            JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
            WHERE i.id_type = ${type} AND i.id_value = ${key} AND i.scope_brand_id = ${brandId} LIMIT ${max}`
        : await sql`
            SELECT DISTINCT i.product_id FROM pmd.product_identifier i
            JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
            WHERE i.id_type = ${type} AND i.id_value = ${key} LIMIT ${max}`,
    );
  }

  // 4 + 5. within the brand: identical core name (pack/variant siblings), then trigram-similar names
  if (brandId != null) {
    add(await sql`
      SELECT product_id FROM pmd.product_master
      WHERE brand_id = ${brandId} AND normalized_name = ${n.coreName} AND record_status = 'ACTIVE' LIMIT ${max * 2}`);
    if (n.coreName) {
      await sql`SELECT set_config('pg_trgm.similarity_threshold', ${String(cfg.match.trigramThreshold)}, true)`;
      add(await sql`
        SELECT product_id FROM pmd.product_master
        WHERE brand_id = ${brandId} AND record_status = 'ACTIVE' AND normalized_name % ${n.coreName}
        ORDER BY similarity(normalized_name, ${n.coreName}) DESC LIMIT ${max}`);
    }
  } else if (n.searchText) {
    // 6. no brand to block on: search the whole master, but demand more similarity
    await sql`SELECT set_config('pg_trgm.similarity_threshold', ${String(Math.max(cfg.match.trigramThreshold, 0.5))}, true)`;
    add(await sql`
      SELECT product_id FROM pmd.product_master
      WHERE record_status = 'ACTIVE' AND search_text % ${n.searchText}
      ORDER BY similarity(search_text, ${n.searchText}) DESC LIMIT ${max}`);
  }
  return [...ids];
}

export interface MatchOutcome {
  decision: MatchDecision;
  scored: ScoredCandidate[];
  subject: MatchSubject;
}

/** Retrieve candidates, score each, decide. Read-only. */
export async function matchNormalized(
  sql: Queryable,
  n: NormalizedProduct,
  brandId: number | null,
  cfg: PmdConfig,
): Promise<MatchOutcome> {
  const subject = subjectFromNormalized(n);
  const ids = await findCandidateIds(sql, n, brandId, cfg);
  const rows = await loadMasterRows(sql, ids);
  const scored = rows.map((r) => ({
    productId: r.product_id,
    result: scoreMatch(subject, subjectFromMasterRow(r), cfg.match),
  }));
  return { decision: decide(scored, cfg.match), scored, subject };
}
