/**
 * The bulk loader must be indistinguishable from the per-record (reference) loader in what it writes.
 * Each scenario is run once per loader on an empty schema, and a canonical dump of the result
 * (no surrogate ids, no timestamps) is compared.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StagedProduct } from "@/server/pmd/types";
import { count, gtin13, ingest, pmdSql, product, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

async function dump(): Promise<unknown> {
  const q = (text: string) => sql.unsafe(text).then((r) => JSON.parse(JSON.stringify(r)));
  return {
    masters: await q(`SELECT m.product_name, m.gtin, b.brand_name, m.record_status, m.version, m.data_quality_score, m.search_keywords, m.field_sources
      FROM pmd.product_master m LEFT JOIN pmd.brand b USING (brand_id) ORDER BY m.product_name, m.gtin NULLS FIRST, m.version`),
    sources: await q(`SELECT s.source_key, ps.source_product_id, ps.source_mrp_minor, ps.content_hash, m.product_name
      FROM pmd.product_source ps JOIN pmd.source s USING (source_id) LEFT JOIN pmd.product_master m USING (product_id)
      ORDER BY 1, 2`),
    offers: await q(`SELECT ps.source_product_id, o.mrp_minor, o.price_minor, o.is_current
      FROM pmd.product_offer o JOIN pmd.product_source ps ON ps.product_source_id = o.product_source_id ORDER BY 1, 2, 3, 4`),
    identifiers: await q(`SELECT m.product_name, i.id_type, i.id_value FROM pmd.product_identifier i JOIN pmd.product_master m USING (product_id) ORDER BY 1, 2, 3`),
    aliases: await q(`SELECT alias_key, alias_original FROM pmd.brand_alias ORDER BY 1`),
    candidates: await q(`SELECT match_status, review_status, count(*)::int AS n FROM pmd.match_candidate GROUP BY 1, 2 ORDER BY 1, 2`),
    errors: await q(`SELECT stage, error_code, count(*)::int AS n FROM pmd.import_error GROUP BY 1, 2 ORDER BY 1, 2`),
    history: await q(`SELECT count(*)::int AS n FROM pmd.price_history`),
  };
}

const brands = ["Amul", "Tata", "Nestle", "Britannia", "Fortune"];
const rows = (n: number, tweak = (r: StagedProduct, _i: number) => r): StagedProduct[] =>
  Array.from({ length: n }, (_, i) => tweak(product({
    sourceProductId: `P${i}`,
    name: `${brands[i % 5]} Item ${i % 37} Variant ${Math.floor(i / 37)} ${i % 3 === 0 ? "500 g" : "1 kg"}`,
    brand: brands[i % 5],
    offer: { mrp: 100 + i, price: 90 + i },
    ...(i % 7 === 0 ? { gtin: gtin13(String(890200100000 + i)) } : {}),
  }), i));

type Step = { key: string; rows: StagedProduct[]; kind?: "BRAND_MANUFACTURER" | "MARKETPLACE" | "OPEN_DATA" };
const scenarios: Record<string, Step[]> = {
  "new records, several sources with overlaps": [
    { key: "test_a", rows: rows(120) },
    { key: "test_b", rows: rows(90, (r) => ({ ...r, name: `${r.name} ` , offer: { mrp: 105, price: 95 } })) },
    { key: "test_m", kind: "BRAND_MANUFACTURER", rows: rows(40) },
  ],
  "re-run unchanged, then price changes, then descriptive changes": [
    { key: "test_a", rows: rows(80) },
    { key: "test_a", rows: rows(80) },
    { key: "test_a", rows: rows(80, (r, i) => (i % 4 === 0 ? { ...r, offer: { mrp: 999, price: 888 } } : r)) },
    { key: "test_a", rows: rows(80, (r, i) => (i % 5 === 0 ? { ...r, name: `${r.name} New Pack` } : r)) },
  ],
  "duplicates inside one batch and bad rows": [
    { key: "test_a", rows: [product({ sourceProductId: "x1", name: "Amul Butter 100 g", brand: "Amul" }), product({ sourceProductId: "x2", name: "Amul Butter 100g", brand: "Amul" }),
      product({ sourceProductId: "x3", name: "Amul Butter 500 g", brand: "Amul" }), product({ sourceProductId: "x4", name: "", brand: "Amul" }),
      product({ sourceProductId: "x5", name: "Mystery", gtin: "1234567890123" }), ...rows(30)] },
  ],
};

describe("bulk loader is equivalent to the reference loader", () => {
  for (const [name, steps] of Object.entries(scenarios)) {
    it(name, async () => {
      const results: Record<string, unknown> = {};
      for (const loader of ["record", "batch"] as const) {
        await resetPmd();
        for (const s of steps) await ingest(s.key, s.rows, { kind: s.kind, loader });
        results[loader] = await dump();
      }
      expect(results.batch).toEqual(results.record);
    });
  }

  it("parallel workers produce the same result as one", async () => {
    const out: unknown[] = [];
    for (const workers of [1, 4]) {
      await resetPmd();
      await ingest("test_a", rows(150), { workers });
      await ingest("test_b", rows(100, (r) => ({ ...r, offer: { mrp: 1, price: 1 } })), { workers });
      out.push(await dump());
    }
    expect(out[1]).toEqual(out[0]);
  });

  it("a failing record does not lose the rest of its batch, and a rolled-back brand is not cached", async () => {
    const summary = await ingest("test_a", [
      product({ sourceProductId: "g1", name: "Zed Thing 1", brand: "Zedco" }),
      product({ sourceProductId: "g2", name: "Zed Thing 2", brand: "Zedco" }),
      ...rows(10),
    ]);
    expect(summary.counters.recordsRead).toBe(12);
    expect(await count(sql, "pmd.product_master", "product_name LIKE 'Zed Thing%'")).toBe(2);
    expect(await count(sql, "pmd.brand", "brand_name = 'Zedco'")).toBe(1);
    const orphans = await sql`SELECT 1 FROM pmd.product_master m WHERE brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pmd.brand b WHERE b.brand_id = m.brand_id)`;
    expect(orphans.length).toBe(0);
  });
});
