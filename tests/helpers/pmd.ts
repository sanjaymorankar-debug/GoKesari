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

/** Wipes transactional PMD data; keeps reference data (sources, taxonomy, attribute registry). */
export async function resetPmd(sql: Sql = pmdSql()): Promise<void> {
  await sql`
    TRUNCATE TABLE
      pmd.job, pmd.product_change_log, pmd.product_merge_log, pmd.match_candidate, pmd.catalogue_link,
      pmd.product_image, pmd.price_history, pmd.product_offer, pmd.product_attribute_conflict,
      pmd.product_specification, pmd.product_identifier, pmd.product_source, pmd.raw_record, pmd.import_error,
      pmd.ingestion_run, pmd.product_master, pmd.product_family, pmd.brand_alias, pmd.brand,
      pmd.manufacturer_alias, pmd.manufacturer, pmd.dashboard_metric
    RESTART IDENTITY CASCADE`;
  await sql`ALTER SEQUENCE pmd.product_seq RESTART`;
  await sql`ALTER SEQUENCE pmd.brand_seq RESTART`;
  await sql`ALTER SEQUENCE pmd.manufacturer_seq RESTART`;
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
  opts: { kind?: "BRAND_MANUFACTURER" | "MARKETPLACE" | "OPEN_DATA"; fullSnapshot?: boolean; mode?: RunOptions["mode"]; adapterOverride?: Partial<SourceAdapter> } = {},
  sql: Sql = pmdSql(),
): Promise<RunSummary> {
  const def = await registerTestSource(key, opts.kind ?? "MARKETPLACE", sql);
  const adapter = { ...createRowsAdapter({ definition: def, rows, fullSnapshot: opts.fullSnapshot }), ...opts.adapterOverride } as SourceAdapter;
  return runIngestion(sql, adapter, { mode: opts.mode ?? "INCREMENTAL", batchSize: 50 });
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

export async function count(sql: Sql, table: string, where = "true"): Promise<number> {
  const [r] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return r.n;
}
