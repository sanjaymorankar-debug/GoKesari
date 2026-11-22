/**
 * A line of a shopping list → master catalogue products (docs/smart-shopping-2026-11).
 * Fuzzy name match (pg_trgm on products.name), local-language names and
 * synonyms (product_local_names.search_text: साखर = Sugar, तूप = Ghee) and
 * spelling variations. Returns up to `limit` approved, active products with a
 * 0–100 score.
 */
import { sql } from "drizzle-orm";

import type { MatchCandidate } from "@/lib/smart-list";
import { db } from "@/server/db";

export interface MatchQuery {
  nameEn: string;
  nameLocal?: string | null;
  raw?: string | null;
  brand?: string | null;
}

type Row = {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
  unit_size_milli: number;
  image_url: string | null;
  score: number;
};

function clean(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[0-9०-९.,/()\-₹]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function matchProducts(q: MatchQuery, limit = 5): Promise<MatchCandidate[]> {
  const en = clean(q.nameEn);
  const local = clean(q.nameLocal);
  const raw = clean(q.raw);
  const brand = clean(q.brand);
  if (!en && !local && !raw) return [];
  const enLike = `%${en.replace(/[%_\\]/g, "")}%`;
  const rows = (await db.execute(sql`
    WITH cand AS (
      SELECT p.id, p.name, b.name AS brand, p.unit, p.unit_size_milli, p.image_url,
        GREATEST(
          CASE WHEN ${en} <> '' THEN similarity(lower(p.name), ${en}) ELSE 0 END,
          CASE WHEN ${en} <> '' THEN word_similarity(${en}, lower(p.name)) * 0.9 ELSE 0 END,
          CASE WHEN ${en} <> '' AND pln.search_text IS NOT NULL THEN word_similarity(${en}, pln.search_text) ELSE 0 END,
          CASE WHEN ${local} <> '' AND pln.search_text IS NOT NULL THEN word_similarity(${local}, pln.search_text) ELSE 0 END,
          CASE WHEN ${raw} <> '' AND pln.search_text IS NOT NULL THEN word_similarity(${raw}, pln.search_text) * 0.9 ELSE 0 END
        )
        + CASE WHEN ${brand} <> '' AND b.name IS NOT NULL AND lower(b.name) % ${brand} THEN 0.1 ELSE 0 END AS score
      FROM products p
      LEFT JOIN product_local_names pln ON pln.product_id = p.id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.is_active AND p.approval_status = 'APPROVED'
        AND (
          (${en} <> '' AND (p.name % ${en} OR p.name ILIKE ${enLike}))
          OR (pln.search_text IS NOT NULL AND (
            (${en} <> '' AND ${en} <% pln.search_text)
            OR (${local} <> '' AND ${local} <% pln.search_text)
            OR (${raw} <> '' AND ${raw} <% pln.search_text)
          ))
        )
    )
    SELECT * FROM cand ORDER BY score DESC, length(name) ASC LIMIT ${limit}
  `)) as unknown as Row[];
  return rows.map((r) => ({
    productId: r.id,
    name: r.name,
    brand: r.brand,
    unit: r.unit,
    unitSizeMilli: Number(r.unit_size_milli),
    imageUrl: r.image_url,
    score: Math.max(0, Math.min(100, Math.round(Number(r.score) * 100))),
  }));
}

/** Products for the manual "change product" picker. */
export async function searchProductsForList(text: string, limit = 10): Promise<MatchCandidate[]> {
  return matchProducts({ nameEn: text, nameLocal: text, raw: text }, limit);
}
