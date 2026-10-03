/**
 * Test helpers for the Product Master Data Platform.
 *
 * PMD integration tests use the same TEST_DATABASE_URL as the rest of the suite
 * (tests/setup.ts points DATABASE_URL at it before any module loads).
 */
import { createSql, type Sql } from "@/server/pmd/db";
import { gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { runIngestion, type RunOptions, type RunSummary } from "@/server/pmd/pipeline/run";
import { ensureReferenceData, upsertSources } from "@/server/pmd/reference-data";
import { createRowsAdapter } from "@/server/pmd/sources/adapters/rows";
import type { SourceAdapter } from "@/server/pmd/sources/adapter";
import type { SourceDefinition, SourceKind, StagedProduct } from "@/server/pmd/types";

let sqlSingleton: Sql | null = null;

export function pmdSql(): Sql {
  if (!sqlSingleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sqlSingleton = createSql(url, { max: 6, applicationName: "gokesari-pmd-tests" });
  }
  return sqlSingleton;
}

/**
 * Order matters only in that it does not: foreign key checks are off for the
 * duration, so children need not precede parents. Child-first order is kept
 * anyway, so the list still reads as the dependency order.
 */
const RESET_TABLES = [
  "job", "product_change_log", "product_merge_log", "match_candidate", "catalogue_link",
  "product_image", "price_history", "product_offer", "product_attribute_conflict",
  "product_specification", "product_identifier", "product_source", "raw_record", "import_error",
  "ingestion_run", "product_master", "product_family", "brand_alias", "brand",
  "manufacturer_alias", "manufacturer", "dashboard_metric",
] as const;

/** Wipes transactional PMD data; keeps reference data (sources, taxonomy, attribute registry). */
export async function resetPmd(sql: Sql = pmdSql()): Promise<void> {
  // One TRUNCATE per table, because MySQL's takes a single table - and on one
  // held connection, because FOREIGN_KEY_CHECKS is a SESSION variable and a
  // pool would scatter the statements across connections, leaving the checks
  // on for most of them.
  //
  // The checks have to be off: half of these tables are the target of a foreign
  // key and MySQL refuses to TRUNCATE such a table, where PostgreSQL's CASCADE
  // simply followed them. TRUNCATE also resets AUTO_INCREMENT by itself, which
  // is what RESTART IDENTITY asked for.
  const held = await sql.reserve();
  try {
    await held.unsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of RESET_TABLES) await held.unsafe(`TRUNCATE TABLE pmd.\`${table}\``);
    // The three application-allocated keys come from pmd.counters rather than
    // AUTO_INCREMENT, so TRUNCATE does not touch them (see mysql/sequence.ts).
    await held.unsafe("DELETE FROM pmd.counters WHERE name IN ('product_seq', 'brand_seq', 'manufacturer_seq')");
    // Locks are rows now; a stale name is harmless but the table should not grow.
    await held.unsafe("DELETE FROM pmd.advisory_lock");
  } finally {
    await held.unsafe("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
    held.release();
  }
}

export async function seedReference(sql: Sql = pmdSql()): Promise<void> {
  await ensureReferenceData(sql);
}

const PRECEDENCE: Record<string, { reliability: number; specPrecedence: number }> = {
  BRAND_MANUFACTURER: { reliability: 95, specPrecedence: 10 },
  MARKETPLACE: { reliability: 65, specPrecedence: 50 },
  OPEN_DATA: { reliability: 55, specPrecedence: 60 },
};

/** Registers an ACTIVE, enabled synthetic source. Test sources are prefixed `test_`. */
export async function registerTestSource(
  key: string,
  kind: Extract<SourceKind, "BRAND_MANUFACTURER" | "MARKETPLACE" | "OPEN_DATA"> = "MARKETPLACE",
  sql: Sql = pmdSql(),
): Promise<SourceDefinition> {
  const def: SourceDefinition = {
    key,
    name: `Test source ${key}`,
    kind,
    accessMethod: kind === "BRAND_MANUFACTURER" ? "MANUFACTURER_FEED" : kind === "MARKETPLACE" ? "OFFICIAL_API" : "OPEN_DATASET",
    status: "ACTIVE",
    legalBasis: "Synthetic fixture used only by automated tests.",
    ...PRECEDENCE[kind],
  };
  await upsertSources(sql, [def]);
  return def;
}

export async function ingest(
  key: string,
  rows: StagedProduct[],
  opts: { kind?: "BRAND_MANUFACTURER" | "MARKETPLACE" | "OPEN_DATA"; fullSnapshot?: boolean; mode?: RunOptions["mode"]; adapterOverride?: Partial<SourceAdapter>; loader?: RunOptions["loader"]; workers?: number } = {},
  sql: Sql = pmdSql(),
): Promise<RunSummary> {
  const def = await registerTestSource(key, opts.kind ?? "MARKETPLACE", sql);
  const adapter = { ...createRowsAdapter({ definition: def, rows, fullSnapshot: opts.fullSnapshot }), ...opts.adapterOverride } as SourceAdapter;
  return runIngestion(sql, adapter, { mode: opts.mode ?? "INCREMENTAL", batchSize: 50, loader: opts.loader, workers: opts.workers });
}

/* ---------------------------------------------------------------- fixtures */

/** Appends the GS1 check digit to a 12-digit body, so fixtures can never carry an invalid GTIN by typo. */
export function gtin13(body12: string): string {
  return body12 + gs1CheckDigit(body12);
}

export const GTIN = {
  AMUL_BUTTER_100: gtin13("890105889578"),
  AMUL_BUTTER_500: gtin13("890105889579"),
  MILK_1L: gtin13("590123412345"),
  PHONE_BLACK: gtin13("401234567890"),
  PHONE_BLUE: gtin13("401234567891"),
  TEA: gtin13("890200100001"),
} as const;

export function product(overrides: Partial<StagedProduct> & { sourceProductId: string }): StagedProduct {
  return { name: "Test Product", ...overrides };
}

/**
 * Runs a multi-statement `.sql` file on one held connection.
 *
 * `multipleStatements` is deliberately **off** on the PMD pool - it is the
 * setting that turns a single injected semicolon into a second statement, and
 * only the migration runner needs it - so a script that carries its own
 * transaction is split here and sent statement by statement. One connection,
 * in order, so the BEGIN/COMMIT the script contains still applies to all of it.
 */
export async function runSqlScript(script: string, sql: Sql = pmdSql()): Promise<void> {
  const statements = script
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const held = await sql.reserve();
  try {
    for (const statement of statements) await held.unsafe(statement);
  } finally {
    held.release();
  }
}

export async function count(sql: Sql, table: string, where = "true"): Promise<number> {
  const [r] = await sql.unsafe<{ n: number }[]>(`SELECT CAST(count(*) AS SIGNED) AS n FROM ${table} WHERE ${where}`);
  return r.n;
}
