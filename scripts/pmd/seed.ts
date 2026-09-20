/**
 * Installs the reference data the platform needs before its first run: the source register
 * (each source with its legal basis and status), the standard taxonomy, the attribute registry
 * and the shipped category mappings. Idempotent - safe to run on every deploy. It writes no
 * product data, and a source that is blocked stays blocked.
 *
 *   PMD_DATABASE_URL=postgresql://... npm run pmd:seed [-- --force]
 *
 * Every run of the pipeline does this too, but only when the definitions in code differ from
 * what the database last received (a stored fingerprint), so it is cheap. Run it explicitly so
 * the read-only screens and API - categories, dashboard - are populated before the first data
 * run. `--force` re-syncs even when the fingerprint matches (after a manual repair of a table).
 */
import { ensureReferenceData } from "@/server/pmd/reference-data";
import { connect, describeTarget, flag, pmdDatabaseUrl } from "./lib";

async function main() {
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  const sql = connect();
  try {
    const ref = await ensureReferenceData(sql, { force: flag("force") });
    console.log(ref.synced ? "synced   the database was updated to match the definitions in code" : "current  the database already matches the definitions in code (use --force to re-sync)");
    const [c] = await sql<{ sources: number; active: number; blocked: number; categories: number; attributes: number; mappings: number }[]>`
      SELECT (SELECT count(*) FROM pmd.source) AS sources,
             (SELECT count(*) FROM pmd.source WHERE enabled) AS active,
             (SELECT count(*) FROM pmd.source WHERE status LIKE 'BLOCKED%') AS blocked,
             (SELECT count(*) FROM pmd.category) AS categories,
             (SELECT count(*) FROM pmd.attribute_definition) AS attributes,
             (SELECT count(*) FROM pmd.category_mapping) AS mappings`;
    console.log(`sources ${c.sources} (${c.active} enabled, ${c.blocked} blocked)  categories ${c.categories}  attributes ${c.attributes}  category mappings ${c.mappings}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
