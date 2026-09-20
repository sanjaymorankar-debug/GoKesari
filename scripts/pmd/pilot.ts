/**
 * Pilot run: ingest the real, lawfully collected open-data samples into a LOCAL
 * database, in dependency order (products first, then the price observations that
 * attach to them).
 *
 *   PMD_DATABASE_URL=postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd \
 *     npx tsx scripts/pmd/pilot.ts [--reset] [--limit N] [--only open_food_facts]
 *
 * Refuses a non-local database unless PMD_ALLOW_REMOTE=1 (see lib.ts). Samples are
 * produced by fetch-sample.ts / fetch-prices.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runIngestion } from "@/server/pmd/pipeline/run";
import { ensureReferenceData } from "@/server/pmd/reference-data";
import { createOpenFactsAdapter, type OpenFactsVariant } from "@/server/pmd/sources/adapters/open-facts";
import { createOpenPricesAdapter } from "@/server/pmd/sources/adapters/open-prices";
import type { SourceAdapter } from "@/server/pmd/sources/adapter";
import { arg, connect, defaultSampleDir, describeTarget, flag, pmdDatabaseUrl } from "./lib";

const OFF_FAMILY: Array<{ key: string; variant: OpenFactsVariant }> = [
  { key: "open_food_facts", variant: "food" },
  { key: "open_beauty_facts", variant: "beauty" },
  { key: "open_products_facts", variant: "products" },
  { key: "open_pet_food_facts", variant: "petfood" },
];

async function main() {
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  const sql = connect();
  const dir = arg("samples", defaultSampleDir())!;
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const only = arg("only");

  if (flag("reset")) {
    await sql`
      TRUNCATE TABLE pmd.job, pmd.product_change_log, pmd.product_merge_log, pmd.match_candidate, pmd.catalogue_link,
        pmd.product_image, pmd.price_history, pmd.product_offer, pmd.product_attribute_conflict, pmd.product_specification,
        pmd.product_identifier, pmd.product_source, pmd.raw_record, pmd.import_error, pmd.ingestion_run, pmd.product_master,
        pmd.product_family, pmd.brand_alias, pmd.brand, pmd.manufacturer_alias, pmd.manufacturer, pmd.dashboard_metric
      RESTART IDENTITY CASCADE`;
    await sql`ALTER SEQUENCE pmd.product_seq RESTART`;
    await sql`ALTER SEQUENCE pmd.brand_seq RESTART`;
    await sql`ALTER SEQUENCE pmd.manufacturer_seq RESTART`;
    console.log("reset    transactional PMD tables cleared (reference data kept)");
  }
  await ensureReferenceData(sql);

  const plan: Array<{ label: string; file: string; make: () => SourceAdapter }> = [
    ...OFF_FAMILY.map((s) => {
      const file = join(dir, `${s.key}.india.jsonl`);
      return { label: s.key, file, make: () => createOpenFactsAdapter(s.variant, { mode: "file", path: file }) };
    }),
    (() => {
      const file = join(dir, "open_prices.inr.jsonl");
      return { label: "open_prices", file, make: () => createOpenPricesAdapter({ mode: "file", path: file }) };
    })(),
  ];

  const rows: Array<Record<string, string | number>> = [];
  for (const step of plan) {
    if (only && step.label !== only) continue;
    if (!existsSync(step.file)) {
      console.log(`skip     ${step.label}: no sample at ${step.file}`);
      continue;
    }
    process.stdout.write(`ingest   ${step.label} ... `);
    const res = await runIngestion(sql, step.make(), { mode: "PILOT", limit, triggeredBy: "pilot-cli", batchSize: 200 });
    const c = res.counters;
    console.log(`${res.status} in ${(res.durationMs / 1000).toFixed(1)}s`);
    rows.push({
      source: step.label, read: c.recordsRead, created: c.productsCreated, linked: c.productsLinked, updated: c.productsUpdated,
      unchanged: c.recordsUnchanged, offers: c.offersUpserted, "price changes": c.priceChanges, "review queue": c.reviewQueued,
      conflicts: c.conflictsOpened, errors: c.errorCount,
    });
  }
  console.table(rows);
  await sql.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  process.exit(1);
});
