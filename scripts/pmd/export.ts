/**
 * Writes GOKESARI_PRODUCT_MASTER.xlsx from the product-master database.
 *
 *   PMD_DATABASE_URL=postgresql://... npx tsx scripts/pmd/export.ts \
 *       [--out <dir>] [--label "PILOT - open data only"] [--per-file 50000]
 *
 * READ-ONLY: it only selects. Datasets larger than one workbook can hold are split into
 * range-partitioned part files (Excel is a reporting format; PostgreSQL is the store).
 */
import { statSync } from "node:fs";

import { exportInParts } from "@/server/pmd/export/excel";
import { failedInvariants } from "@/server/pmd/pipeline/checks";
import { arg, connect, defaultOutputDir, describeTarget, pmdDatabaseUrl } from "./lib";

async function main() {
  console.log(`source   ${describeTarget(pmdDatabaseUrl())}`);
  const sql = connect();
  const out = arg("out", defaultOutputDir())!;

  // Never publish a workbook from a database that violates its own invariants.
  const failed = await failedInvariants(sql);
  if (failed.length) {
    console.error("Refusing to export: invariant checks failed:");
    for (const f of failed) console.error(`  - ${f.id}: ${f.violations} violation(s) - ${f.description}`);
    process.exit(2);
  }

  await sql`SELECT pmd.refresh_dashboard()`;
  const parts = await exportInParts(sql, out, {
    baseName: "GOKESARI_PRODUCT_MASTER",
    productsPerFile: Number(arg("per-file", "50000")),
    label: arg("label", "Product master export"),
  });
  for (const p of parts) {
    console.log(`wrote    ${p.file}  (${(statSync(p.file).size / 1048576).toFixed(2)} MB)`);
    console.table(p.counts);
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
