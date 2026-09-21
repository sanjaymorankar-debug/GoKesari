/**
 * Loader benchmark: how fast does the real pipeline load records on top of a large master, and how does that
 * change with network latency? Uses a THROWAWAY database (refuses non-local hosts like every pmd tool).
 *
 *   PMD_DATABASE_URL=postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd_bench \
 *     npx tsx scripts/pmd/bench-loader.ts --products 1000000 --records 5000 --rtt 20 \
 *       [--scenario new|unchanged|price|mixed] [--loader record|batch] [--workers 4] [--profile]
 *
 * --rtt <ms>       put a latency-injecting proxy between the loader and PostgreSQL (round trip = ms)
 * --profile        report the statements the load ran (pg_stat_statements): count per record and the costliest
 * --gtin-offset N  use a different block of GTINs so a second run loads NEW records into the same database
 *
 * Synthetic records look like a GS1 / manufacturer load: barcode, brand, manufacturer, pack, GST, HSN, two
 * specifications and an MRP offer.
 */
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

import { createSql, type Sql } from "@/server/pmd/db";
import { gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { runIngestion, type RunOptions, type RunSummary } from "@/server/pmd/pipeline/run";
import { ensureReferenceData, upsertSources } from "@/server/pmd/reference-data";
import { createRowsAdapter } from "@/server/pmd/sources/adapters/rows";
import type { SourceDefinition, StagedProduct } from "@/server/pmd/types";
import { startLatencyProxy } from "./latency-proxy";
import { arg, connect, describeTarget, flag, pmdDatabaseUrl } from "./lib";
import { ensureSyntheticMasters } from "./synthetic";

const DEF: SourceDefinition = {
  key: "bench_loader", name: "Loader benchmark feed", kind: "GS1", accessMethod: "LICENSED_FEED", status: "ACTIVE",
  legalBasis: "Synthetic benchmark data - nothing real.",
};

/** A deterministic pseudo-word: real catalogues do not name thousands of products "Item1", "Item2", ... */
function word(seed: number): string {
  let x = Math.imul(seed + 1, 2654435761) >>> 0;
  let w = "";
  for (let k = 0; k < 7; k++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    w += "abcdefghijklmnopqrstuvwxyz"[(x >>> 16) % 26];
  }
  return w[0].toUpperCase() + w.slice(1);
}

function makeRecords(n: number, offset: number, brands: number, priceBump = 0): StagedProduct[] {
  const rows: StagedProduct[] = [];
  for (let i = 0; i < n; i++) {
    const id = offset + i;
    const body = String(880000000000 + id).padStart(12, "0").slice(-12);
    const pack = 100 + (i % 9) * 100;
    rows.push({
      sourceProductId: `LB-${id}`,
      name: `Loader Brand${i % brands} ${word(id)} ${word(id * 7 + 3)} ${pack} g`,
      brand: `Loader Brand${i % brands}`,
      manufacturer: `Loader Maker ${i % 7}`,
      gtin: body + gs1CheckDigit(body),
      quantityText: `${pack} g`,
      gstRate: "18%",
      hsnCode: "1905",
      countryOfOrigin: "India",
      attributes: [{ key: "shelf_life", value: "6 months" }, { key: "ingredients", value: "wheat flour, sugar" }],
      offer: { sellerName: "Loader Maker", mrp: 100 + (i % 400) + priceBump, collectedAt: priceBump ? "2026-09-08" : "2026-09-01" },
    });
  }
  return rows;
}

const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`);

async function main() {
  const url = new URL(pmdDatabaseUrl());
  console.log(`target   ${describeTarget(url.toString())}`);
  const products = Number(arg("products", "1000000"));
  const records = Number(arg("records", "3000"));
  const rtt = Number(arg("rtt", "0"));
  const workers = Number(arg("workers", "1"));
  const scenario = arg("scenario", "new")!;
  const loader = arg("loader");
  const offset = Number(arg("gtin-offset", "0"));
  const brands = Number(arg("brands", "50"));
  const profile = flag("profile");

  const admin = connect();
  await ensureReferenceData(admin);
  await ensureSyntheticMasters(admin, products);
  await upsertSources(admin, [DEF]);
  await ensureReferenceData(admin);

  let proxy: Awaited<ReturnType<typeof startLatencyProxy>> | null = null;
  let sql: Sql = admin;
  if (rtt > 0) {
    proxy = await startLatencyProxy({ targetHost: url.hostname, targetPort: Number(url.port || 5432), oneWayMs: rtt / 2 });
    const proxied = new URL(url.toString());
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    sql = createSql(proxied.toString(), { max: Math.max(2, workers + 1) });
  } else if (workers > 1) {
    sql = createSql(url.toString(), { max: workers + 1 });
  }

  const opts = (mode: RunOptions["mode"]): RunOptions =>
    ({ mode, batchSize: Number(arg("batch-size", "500")), ...(loader ? { loader } : {}), ...(workers > 1 ? { workers } : {}) }) as RunOptions;
  const rows = makeRecords(records, offset, brands);
  const adapterFor = (r: StagedProduct[]) => createRowsAdapter({ definition: DEF, rows: r });

  const run = async (label: string, r: StagedProduct[], mode: RunOptions["mode"]): Promise<RunSummary> => {
    if (profile) {
      await admin`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
      await admin`SELECT pg_stat_statements_reset()`;
    }
    const t0 = performance.now();
    const res = await runIngestion(sql, adapterFor(r), opts(mode));
    const ms = performance.now() - t0;
    const c = res.counters;
    let statements = "";
    if (profile) {
      const [{ calls }] = await admin<{ calls: number }[]>`SELECT coalesce(sum(calls), 0)::int AS calls FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      statements = `  ${(calls / r.length).toFixed(1)} statements/record`;
    }
    console.log(
      `${label.padEnd(34)} ${(r.length / (ms / 1000)).toFixed(0).padStart(6)} records/s   ${fmt(ms).padStart(8)}   ` +
        `created ${c.productsCreated} linked ${c.productsLinked} updated ${c.productsUpdated} unchanged ${c.recordsUnchanged} price ${c.priceChanges} errors ${c.errorCount} [${res.status}]${statements}`,
    );
    if (profile) {
      const top = await admin<{ q: string; calls: number; mean: number; total: number }[]>`
        SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 96) AS q, calls::int, round(mean_exec_time::numeric, 2)::float AS mean, round(total_exec_time::numeric, 0)::float AS total
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY total_exec_time DESC LIMIT 12`;
      for (const t of top) console.log(`   ${String(t.total).padStart(7)} ms  ${String(t.calls).padStart(7)} calls  ${String(t.mean).padStart(7)} ms/call  ${t.q}`);
    }
    return res;
  };

  console.log(`master   ${products.toLocaleString()} rows   records ${records.toLocaleString()}   rtt ${rtt} ms   workers ${workers}   loader ${loader ?? "default"}   scenario ${scenario}\n`);
  if (scenario === "new" || scenario === "mixed" || scenario === "unchanged" || scenario === "price") {
    if (scenario === "new" || scenario === "mixed") await run("load NEW records", rows, "INITIAL_FULL");
    if (scenario === "unchanged" || scenario === "mixed") {
      if (scenario === "unchanged") await run("(seed) load NEW records", rows, "INITIAL_FULL");
      await run("re-run, all UNCHANGED", rows, "INCREMENTAL");
    }
    if (scenario === "price" || scenario === "mixed") {
      if (scenario === "price") await run("(seed) load NEW records", rows, "INITIAL_FULL");
      await run("re-run, PRICE change on all", makeRecords(records, offset, brands, 1), "INCREMENTAL");
    }
  }

  if (sql !== admin) await sql.end();
  await proxy?.close();
  await admin.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  process.exit(1);
});
