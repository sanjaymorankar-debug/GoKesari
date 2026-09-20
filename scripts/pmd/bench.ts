/**
 * Scale benchmark: loads N SYNTHETIC masters with SQL, then measures the operations that
 * must stay fast as the master grows, and the real pipeline's throughput on top of it.
 *
 *   PMD_DATABASE_URL=postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd_bench \
 *     npx tsx scripts/pmd/bench.ts --products 1000000
 *
 * Use a THROWAWAY database (refuses non-local hosts like every pmd tool). Synthetic data
 * only proves index behaviour and throughput - it says nothing about data quality.
 */
import { performance } from "node:perf_hooks";

import { gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { runIngestion } from "@/server/pmd/pipeline/run";
import { ensureReferenceData } from "@/server/pmd/reference-data";
import { createRowsAdapter } from "@/server/pmd/sources/adapters/rows";
import { searchProducts, listProducts } from "@/server/pmd/services/products";
import { matchProduct } from "@/server/pmd/services/ingest-api";
import type { SourceDefinition, StagedProduct } from "@/server/pmd/types";
import { arg, connect, describeTarget, pmdDatabaseUrl } from "./lib";

const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(1)} s`);

async function timed<T>(label: string, fn: () => Promise<T>, runs = 1): Promise<T> {
  let out!: T;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    out = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${fmt(times[Math.floor(times.length / 2)])}${runs > 1 ? `  (min ${fmt(times[0])}, max ${fmt(times[times.length - 1])}, n=${runs})` : ""}`);
  return out;
}

async function main() {
  const N = Number(arg("products", "1000000"));
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}   products=${N.toLocaleString()}`);
  const sql = connect();
  await ensureReferenceData(sql);

  const [{ n: existing }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.product_master`;
  if (existing < N) {
    console.log(`loading  ${N.toLocaleString()} synthetic masters (have ${existing.toLocaleString()}) ...`);
    const t0 = performance.now();
    await sql`TRUNCATE pmd.product_master, pmd.brand RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO pmd.brand (brand_name, brand_key)
      SELECT 'Brand ' || substr(md5(i::text), 1, 7), 'brand' || substr(md5(i::text), 1, 7) FROM generate_series(1, ${Math.max(1000, Math.floor(N / 200))}) i`;
    const [{ nb }] = await sql<{ nb: number }[]>`SELECT count(*)::int AS nb FROM pmd.brand`;
    await sql`
      INSERT INTO pmd.product_master (brand_id, category_id, gtin, product_name, normalized_name, search_text, pack_size,
                                      net_quantity_value, net_quantity_unit, pack_count, product_status, data_quality_score)
      SELECT b.brand_id,
             1 + (g % 300),
             -- 14 digits; a check digit is not needed for index behaviour
             lpad((8900000000000 + g)::text, 14, '0'),
             b.brand_name || ' ' || w1 || ' ' || w2 || ' ' || pack.l,
             w1 || ' ' || w2,
             lower(b.brand_name) || ' ' || w1 || ' ' || w2 || ' ' || pack.l,
             pack.l, pack.v, 'g', 1, 'UNKNOWN', 30 + (g % 60)
      FROM generate_series(1, ${N}) g
      CROSS JOIN LATERAL (SELECT (1 + (g % ${nb}))::int AS bid) x
      JOIN pmd.brand b ON b.brand_id = x.bid
      CROSS JOIN LATERAL (SELECT substr(md5((g * 7)::text), 1, 6) AS w1, substr(md5((g * 13)::text), 1, 7) AS w2) w
      CROSS JOIN LATERAL (SELECT ((g % 9) + 1) * 100 AS v, (((g % 9) + 1) * 100)::text || ' g' AS l) pack`;
    console.log(`loaded   in ${fmt(performance.now() - t0)}`);
    await timed("ANALYZE", () => sql`ANALYZE pmd.product_master`);
  } else console.log(`reusing  ${existing.toLocaleString()} existing masters`);

  const [{ total, size, idx }] = await sql<{ total: number; size: string; idx: string }[]>`
    SELECT count(*)::int AS total, pg_size_pretty(pg_table_size('pmd.product_master')) AS size, pg_size_pretty(pg_indexes_size('pmd.product_master')) AS idx FROM pmd.product_master`;
  console.log(`master   ${total.toLocaleString()} rows, table ${size}, indexes ${idx}\n`);

  const probe = await sql<{ gtin: string; brand_id: number; normalized_name: string; product_name: string }[]>`
    SELECT gtin, brand_id, normalized_name, product_name FROM pmd.product_master ORDER BY product_id OFFSET ${Math.floor(total / 2)} LIMIT 1`;
  const p = probe[0];
  const tk = p.normalized_name.split(" ");

  console.log("--- index-backed operations at this size ---");
  await timed("GTIN identifier lookup (unique index)", () => sql`SELECT product_id FROM pmd.product_master WHERE gtin = ${p.gtin} AND record_status = 'ACTIVE'`, 30);
  await timed("brand-blocked trigram candidate retrieval (matcher)", () =>
    sql.begin("read only", async (tx) => {
      await tx`SELECT set_config('pg_trgm.similarity_threshold', '0.35', true)`;
      return tx`SELECT product_id FROM pmd.product_master WHERE brand_id = ${p.brand_id} AND record_status = 'ACTIVE' AND normalized_name % ${p.normalized_name} ORDER BY similarity(normalized_name, ${p.normalized_name}) DESC LIMIT 15`;
    }), 20);
  await timed("sibling lookup (brand + identical core name, btree)", () => sql`SELECT product_id FROM pmd.product_master WHERE brand_id = ${p.brand_id} AND normalized_name = ${p.normalized_name} LIMIT 30`, 30);
  await timed("keyword search across the whole master (GIN full-text)", () => searchProducts(sql, `${tk[0]} ${tk[1]}`, {}, 25), 10);
  await timed("fuzzy search across the whole master (GIN trigram)", () => searchProducts(sql, `${tk[0]}x ${tk[1]}`, {}, 25), 5);
  await timed("list page 1 (keyset)", () => listProducts(sql, {}, { limit: 50 }), 10);
  await timed(`list page at ${Math.floor(total * 0.9).toLocaleString()} (keyset - same cost as page 1)`, () => listProducts(sql, {}, { limit: 50, cursor: String(Math.floor(total * 0.9)) }), 10);
  await timed("dashboard snapshot refresh (full aggregates; runs after each batch, not per request)", () => sql`SELECT pmd.refresh_dashboard()`, 1);

  console.log("\n--- query plans (must not be sequential scans) ---");
  const plans: Array<[string, string]> = [
    ["GTIN lookup", `EXPLAIN SELECT product_id FROM pmd.product_master WHERE gtin = '${p.gtin}' AND record_status = 'ACTIVE'`],
    ["brand+trigram", `EXPLAIN SELECT product_id FROM pmd.product_master WHERE brand_id = ${p.brand_id} AND record_status = 'ACTIVE' AND normalized_name % '${p.normalized_name}'`],
    ["full-text", `EXPLAIN SELECT product_id FROM pmd.product_master WHERE to_tsvector('simple', search_text) @@ to_tsquery('simple', '${tk[0]}:* & ${tk[1]}:*')`],
    ["trigram search_text", `EXPLAIN SELECT product_id FROM pmd.product_master WHERE search_text % '${p.product_name.toLowerCase()}'`],
  ];
  for (const [label, q] of plans) {
    const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(q);
    const plan = rows.map((r) => r["QUERY PLAN"]).join(" | ");
    console.log(`${label.padEnd(22)} ${/Seq Scan/.test(plan) ? "SEQ SCAN !!" : "index"}  ${plan.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  console.log("\n--- real pipeline throughput with the large master present ---");
  const def: SourceDefinition = { key: "bench_feed", name: "Bench feed", kind: "MARKETPLACE", accessMethod: "OFFICIAL_API", status: "ACTIVE", legalBasis: "synthetic benchmark", reliability: 65, specPrecedence: 50 };
  const { upsertSources } = await import("@/server/pmd/reference-data");
  await upsertSources(sql, [def]);
  const M = Number(arg("records", "3000"));
  const rows: StagedProduct[] = [];
  for (let i = 0; i < M; i++) {
    const body = String(8800000000000 + 100000 + i).padStart(12, "0").slice(-12);
    rows.push({
      sourceProductId: `BENCH-${i}`, name: `Benchmark Brand${i % 50} Gadget${i} ${100 + (i % 9) * 100} g`, brand: `Benchmark Brand${i % 50}`,
      gtin: body + gs1CheckDigit(body), gstRate: "18%",
      offer: { sellerName: `Seller ${i % 20}`, price: 100 + (i % 500), mrp: 700, stock: "in stock", collectedAt: "2026-09-01" },
    });
  }
  const first = await timed(`load ${M.toLocaleString()} NEW records (match + create + offer + history)`, () => runIngestion(sql, createRowsAdapter({ definition: def, rows }), { mode: "PILOT", batchSize: 500 }));
  console.log(`         -> ${(M / (first.durationMs / 1000)).toFixed(0)} records/s, created ${first.counters.productsCreated}, errors ${first.counters.errorCount}`);
  const second = await timed(`re-run the same ${M.toLocaleString()} records (unchanged shortcut)`, () => runIngestion(sql, createRowsAdapter({ definition: def, rows }), { mode: "PILOT", batchSize: 500 }));
  console.log(`         -> ${(M / (second.durationMs / 1000)).toFixed(0)} records/s, unchanged ${second.counters.recordsUnchanged}`);
  const priced = rows.map((r) => ({ ...r, offer: { ...r.offer!, price: Number(r.offer!.price) + 1, collectedAt: "2026-09-08" } }));
  const third = await timed(`price-change run over ${M.toLocaleString()} records (history rows)`, () => runIngestion(sql, createRowsAdapter({ definition: def, rows: priced }), { mode: "INCREMENTAL", batchSize: 500 }));
  console.log(`         -> ${(M / (third.durationMs / 1000)).toFixed(0)} records/s, price changes ${third.counters.priceChanges}`);
  await timed("dry-run match of one record against the whole master", () => matchProduct(sql, { sourceProductId: "q", name: `${p.product_name}`, brand: "Brand" }), 5);

  await sql.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  process.exit(1);
});
