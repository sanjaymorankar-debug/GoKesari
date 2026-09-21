/**
 * Runs the automated data-quality and duplicate checks against a product-master database.
 *
 *   PMD_DATABASE_URL=postgresql://... npx tsx scripts/pmd/checks.ts
 *
 * INVARIANT checks must be zero - the process exits 1 if any fails (usable as a deploy gate
 * or a post-ingestion alert). REVIEW checks are steward work-queues and only reported.
 */
import { runChecks } from "@/server/pmd/pipeline/checks";
import { connect, describeTarget, pmdDatabaseUrl } from "./lib";

async function main() {
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  const sql = connect();
  const results = await runChecks(sql);
  let failed = 0;
  for (const r of results) {
    const ok = r.kind === "REVIEW" || r.violations === 0;
    if (!ok) failed++;
    const tag = r.kind === "INVARIANT" ? (ok ? "PASS " : "FAIL ") : "QUEUE";
    console.log(`${tag}  ${r.id.padEnd(30)} ${String(r.violations).padStart(6)}  ${r.description}`);
    if (!ok) console.log("       e.g.", JSON.stringify(r.sample[0]));
  }
  console.log(failed ? `\n${failed} invariant(s) FAILED` : "\nAll invariants hold.");
  await sql.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
