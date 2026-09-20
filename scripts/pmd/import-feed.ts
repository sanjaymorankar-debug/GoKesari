/**
 * Runs a licensed / partner CSV feed through the pipeline, or only checks that its column
 * mapping works.
 *
 *   # 1. Check the mapping. Needs no database; reads the file and reports what would happen.
 *   npx tsx scripts/pmd/import-feed.ts --check --source partner_feed \
 *     --file ./feed.csv --mapping ./feed.mapping.json [--category-map ./categories.json]
 *
 *   # 2. Load it into a database you named explicitly (see lib.ts for the safety rules).
 *   PMD_DATABASE_URL=postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd \
 *     npx tsx scripts/pmd/import-feed.ts --source partner_feed --file ./feed.csv \
 *     --mapping ./feed.mapping.json [--mode IMPORT|INCREMENTAL|INITIAL_FULL] [--full-snapshot]
 *
 * The file must have been obtained lawfully (a written agreement, an affiliate programme's
 * feed terms, or your own data). This tool reads a file; it never fetches anything. The
 * source must be registered and ACTIVE in sources/registry.ts - that entry is where the
 * legal basis is written down and reviewed.
 *
 * --mapping       JSON: platform field -> feed column, e.g. {"sourceProductId":"SKU","name":"Title"}.
 *                 Falls back to the registry entry's fieldMapping.
 * --category-map  JSON: exact feed category text -> standard category code
 *                 (e.g. {"Smartphones":"electronics/mobiles/smartphones"}). Unmapped stays NULL.
 */
import { readFileSync } from "node:fs";

import { normalizeStaged } from "@/server/pmd/normalize";
import { runIngestion, type RunMode } from "@/server/pmd/pipeline/run";
import { ensureReferenceData } from "@/server/pmd/reference-data";
import { standardCodeMapper } from "@/server/pmd/services/ingest-api";
import { ParseError } from "@/server/pmd/sources/adapter";
import { createCsvFeedAdapter, type FeedMapping } from "@/server/pmd/sources/adapters/csv-feed";
import { getSourceDefinition } from "@/server/pmd/sources/registry";
import { getCategoryByCode } from "@/server/pmd/taxonomy/categories";
import { chainMappers, createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { arg, connect, describeTarget, flag, pmdDatabaseUrl } from "./lib";

const MODES: RunMode[] = ["IMPORT", "INCREMENTAL", "INITIAL_FULL"];
const FEED_PARSERS = new Set(["csv_feed", "json_rows"]);

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
  } catch (e) {
    throw new Error(`Cannot read ${what} "${path}": ${e instanceof Error ? e.message : e}`);
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

async function main() {
  const sourceKey = arg("source") ?? fail("--source <registry key> is required (e.g. partner_feed)");
  const file = arg("file") ?? fail("--file <feed.csv> is required");
  const check = flag("check");

  const def = getSourceDefinition(sourceKey);
  if (!def) fail(`"${sourceKey}" is not in the source registry. Add an entry (with its legal basis) to sources/registry.ts first.`);
  if (def.status !== "ACTIVE") fail(`"${sourceKey}" is ${def.status}: ${def.legalBasis}`);
  if (!def.parserKey || !FEED_PARSERS.has(def.parserKey)) fail(`"${sourceKey}" is not a file-feed source (parser "${def.parserKey ?? "none"}").`);

  const mapping = arg("mapping") ? readJson<FeedMapping>(arg("mapping")!, "mapping file") : def.fieldMapping;
  if (!mapping?.sourceProductId) fail("the mapping must name the sourceProductId column (--mapping <file.json>).");

  const mode = (arg("mode") ?? "IMPORT") as RunMode;
  if (!MODES.includes(mode)) fail(`--mode must be one of ${MODES.join(", ")}`);
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  let categoryMapper = standardCodeMapper();
  if (arg("category-map")) {
    const map = readJson<Record<string, string>>(arg("category-map")!, "category map");
    const unknown = Object.values(map).filter((code) => !getCategoryByCode(code));
    if (unknown.length) fail(`category map names unknown standard categories: ${[...new Set(unknown)].join(", ")}`);
    categoryMapper = chainMappers(createCategoryMapper({ tags: map, keywords: [] }), categoryMapper);
  }

  const adapter = createCsvFeedAdapter({
    definition: def,
    input: { path: file },
    mapping,
    delimiter: arg("delimiter"),
    listSeparator: arg("list-separator"),
    fullSnapshot: flag("full-snapshot"),
    categoryMapper,
  });

  if (check) {
    await checkFeed(adapter, limit);
    return;
  }

  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  console.log(`source   ${def.key}  (${def.name})  mode=${mode}  file=${file}`);
  const sql = connect();
  try {
    await ensureReferenceData(sql);
    const summary = await runIngestion(sql, adapter, { mode, limit, triggeredBy: "cli:import-feed", log: (m) => console.log(`  ${m}`) });
    const c = summary.counters;
    console.log(
      `\nrun ${summary.runId} ${summary.status} in ${(summary.durationMs / 1000).toFixed(1)}s\n` +
        `  read ${c.recordsRead}  created ${c.productsCreated}  linked ${c.productsLinked}  updated ${c.productsUpdated}  unchanged ${c.recordsUnchanged}\n` +
        `  offers ${c.offersUpserted}  price changes ${c.priceChanges}  queued for review ${c.reviewQueued}  errors ${c.errorCount}` +
        (summary.errorSummary ? `\n  ${summary.errorSummary}` : ""),
    );
    if (c.errorCount) console.log("  see pmd.import_error for the rows that were not loaded, and why");
  } finally {
    await sql.end();
  }
}

/** Parses and normalises every row without touching a database. */
async function checkFeed(adapter: ReturnType<typeof createCsvFeedAdapter>, limit?: number) {
  const logs: string[] = [];
  const parseErrors = new Map<string, number>();
  const issues = new Map<string, number>();
  const samples: string[] = [];
  let read = 0;
  let loadable = 0;
  let withGtin = 0;
  let withBrand = 0;
  let withCategory = 0;
  let withPrice = 0;

  for await (const raw of adapter.extract({ limit, log: (m) => logs.push(m) })) {
    read++;
    try {
      const n = normalizeStaged(adapter.parse(raw), { categoryMapper: adapter.categoryMapper });
      const blocking = n.issues.some((i) => i.severity === "ERROR") || !n.name;
      if (!blocking) loadable++;
      if (n.gtin?.usableForMatching) withGtin++;
      if (n.brand) withBrand++;
      if (n.categoryCode) withCategory++;
      if (n.offer?.priceMinor != null) withPrice++;
      for (const i of n.issues) {
        const key = `${i.severity} ${i.code}`;
        issues.set(key, (issues.get(key) ?? 0) + 1);
        if (samples.length < 8 && i.severity === "ERROR") samples.push(`${raw.sourceProductId}: ${i.code} - ${i.message}`);
      }
    } catch (e) {
      const code = e instanceof ParseError ? e.code : "PARSE_FAILED";
      parseErrors.set(code, (parseErrors.get(code) ?? 0) + 1);
      if (samples.length < 8) samples.push(`${raw.sourceProductId}: ${code} - ${e instanceof Error ? e.message : e}`);
    }
  }

  const pct = (n: number) => (read ? `${((100 * n) / read).toFixed(0)}%` : "-");
  console.log(`rows read              ${read}`);
  console.log(`would load             ${loadable} (${pct(loadable)})`);
  console.log(`  usable GTIN          ${withGtin} (${pct(withGtin)})`);
  console.log(`  brand                ${withBrand} (${pct(withBrand)})`);
  console.log(`  standard category    ${withCategory} (${pct(withCategory)})   <- unmapped categories stay NULL; extend --category-map`);
  console.log(`  price                ${withPrice} (${pct(withPrice)})`);
  if (parseErrors.size) console.log(`parse errors           ${[...parseErrors].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (issues.size) console.log(`normalisation issues   ${[...issues].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  for (const l of logs) console.log(`note: ${l}`);
  if (samples.length) console.log(`\nfirst problems:\n  ${samples.join("\n  ")}`);
  console.log("\ncheck only - nothing was written.");
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
