/**
 * Benchmark of the batched, resumable import path (batch-2026-10 WS-D, F9.1.4) on a generated file:
 * parse + validate + stage N rows into a job, then run the worker until the job is done.
 *
 *   PMD_DATABASE_URL=<local db> npx tsx scripts/pmd/bench-ingest.ts [--rows 100000] [--batch 1000] [--no-load]
 *
 * Writes to that database (a manufacturer account "Bench Manufacturer", its source and staged products), so use a
 * throwaway LOCAL database (PMD_ALLOW_REMOTE=1 is needed for anything else, as for every pmd tool).
 */
import { arg, describeTarget, flag, pmdDatabaseUrl } from "./lib";

async function main() {
  const url = pmdDatabaseUrl();
  // The services read DATABASE_URL; point it at the named target only.
  process.env.DATABASE_URL = url;
  process.env.PMD_INGEST_AUTORUN = "off";
  process.env.AUTH_SECRET ??= "bench";
  process.env.CRON_SECRET ??= "bench";
  const rows = Number(arg("rows", "100000"));
  const batch = Number(arg("batch", "1000"));
  console.log(`target   ${describeTarget(url)}  rows ${rows}  batch ${batch}`);

  const { gs1CheckDigit } = await import("@/server/pmd/normalize/identifiers");
  const { ensureReferenceData } = await import("@/server/pmd/reference-data");
  const { appSql } = await import("@/server/pmd/db");
  const { createManufacturerAccount, manufacturerAccountsForUser } = await import("@/server/pmd/manufacturers");
  const { createManufacturerJob, processIngestJob } = await import("@/server/pmd/ingest-jobs");
  const { setRule } = await import("@/server/services/settings");
  const { db } = await import("@/server/db");
  const { pmdManufacturerAccounts, users } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  void manufacturerAccountsForUser;

  await ensureReferenceData(appSql());
  let [admin] = await db.select().from(users).where(eq(users.email, "bench-admin@gokesari.local"));
  if (!admin) [admin] = await db.insert(users).values({ email: "bench-admin@gokesari.local", role: "ADMIN" }).returning();
  const actor = { id: admin.id, role: "ADMIN" as const };
  await setRule("pmdSources", { ingestBatchSize: batch, imagesEnabled: false }, actor);
  let [account] = await db.select().from(pmdManufacturerAccounts).where(eq(pmdManufacturerAccounts.slug, "bench_manufacturer"));
  if (!account) account = await createManufacturerAccount({ name: "Bench Manufacturer", brandNames: ["Benchbrand"] }, actor);

  // Realistic spread, as in scripts/pmd/synthetic.ts: ~rows/200 brands and distinct names. (One brand with
  // near-identical names is the matcher's worst case — every record is a fuzzy candidate of every other.)
  const { createHash } = await import("node:crypto");
  const h = (s: string, n: number) => createHash("md5").update(s).digest("hex").slice(0, n);
  const brands = Math.max(50, Math.floor(rows / 200));
  const run = Date.now().toString(36).slice(-4);
  const lines = ["GTIN,Product Name,Brand,Category,Pack Size,MRP,GST %,HSN"];
  const seed = Math.floor(Math.random() * 90) + 10;
  for (let i = 1; i <= rows; i++) {
    const body = `89${seed}${String(i).padStart(8, "0")}`;
    const pack = `${((i % 9) + 1) * 100} g`;
    lines.push(`${body}${gs1CheckDigit(body)},${h(`${run}a${i}`, 6)} ${h(`${run}b${i}`, 7)} ${pack},Brand ${h(`b${i % brands}`, 7)},dairy/milk,${pack},${(i % 400) + 10}.00,5,04012000`);
  }
  const t0 = Date.now();
  const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: `bench-${rows}.csv`, file: Buffer.from(lines.join("\n")), autoStart: false }, actor);
  const staged = Date.now() - t0;
  console.log(`staged   ${job.totalRows} rows (valid ${job.validRows}) in ${staged} ms  (${Math.round((job.totalRows / staged) * 1000)} rows/s)`);
  if (flag("no-load")) process.exit(0);

  const t1 = Date.now();
  for (;;) {
    const p = await processIngestJob(job.id, { maxBatches: 10 });
    const s = (Date.now() - t1) / 1000;
    console.log(`load     ${p.stagedRows}/${p.validRows} (${p.percent}%)  ${s.toFixed(1)} s  ${Math.round(p.stagedRows / Math.max(s, 0.001))} rows/s`);
    if (p.status !== "RUNNING" && p.status !== "QUEUED") break;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
