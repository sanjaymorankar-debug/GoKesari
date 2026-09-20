/**
 * Synthetic masters for scale benchmarks: N products with valid-shaped (not check-digit-valid) 14-digit GTINs,
 * spread over ~N/200 brands. Loaded with one INSERT ... SELECT so a million rows take about three minutes.
 * It proves index behaviour and throughput; it says nothing about data quality.
 */
import { performance } from "node:perf_hooks";

import type { Sql } from "@/server/pmd/db";

export async function ensureSyntheticMasters(sql: Sql, n: number, log: (m: string) => void = console.log): Promise<number> {
  const [{ existing }] = await sql<{ existing: number }[]>`SELECT count(*)::int AS existing FROM pmd.product_master`;
  if (existing >= n) {
    log(`reusing  ${existing.toLocaleString()} existing masters`);
    return existing;
  }
  log(`loading  ${n.toLocaleString()} synthetic masters (have ${existing.toLocaleString()}) ...`);
  const t0 = performance.now();
  await sql`TRUNCATE pmd.product_master, pmd.brand RESTART IDENTITY CASCADE`;
  await sql`
    INSERT INTO pmd.brand (brand_name, brand_key)
    SELECT 'Brand ' || substr(md5(i::text), 1, 7), 'brand' || substr(md5(i::text), 1, 7) FROM generate_series(1, ${Math.max(1000, Math.floor(n / 200))}) i`;
  const [{ nb }] = await sql<{ nb: number }[]>`SELECT count(*)::int AS nb FROM pmd.brand`;
  await sql`
    INSERT INTO pmd.product_master (brand_id, category_id, gtin, product_name, normalized_name, search_text, pack_size,
                                    net_quantity_value, net_quantity_unit, pack_count, product_status, data_quality_score)
    SELECT b.brand_id,
           1 + (g % 300),
           lpad((8900000000000 + g)::text, 14, '0'),
           b.brand_name || ' ' || w1 || ' ' || w2 || ' ' || pack.l,
           w1 || ' ' || w2,
           lower(b.brand_name) || ' ' || w1 || ' ' || w2 || ' ' || pack.l,
           pack.l, pack.v, 'g', 1, 'UNKNOWN', 30 + (g % 60)
    FROM generate_series(1, ${n}) g
    CROSS JOIN LATERAL (SELECT (1 + (g % ${nb}))::int AS bid) x
    JOIN pmd.brand b ON b.brand_id = x.bid
    CROSS JOIN LATERAL (SELECT substr(md5((g * 7)::text), 1, 6) AS w1, substr(md5((g * 13)::text), 1, 7) AS w2) w
    CROSS JOIN LATERAL (SELECT ((g % 9) + 1) * 100 AS v, (((g % 9) + 1) * 100)::text || ' g' AS l) pack`;
  log(`loaded   in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await sql`ANALYZE pmd.product_master`;
  return n;
}
