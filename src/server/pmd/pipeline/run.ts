/**
 * The ingestion run: EXTRACT -> PARSE -> NORMALISE -> MATCH -> VALIDATE -> LOAD.
 *
 * Streams records from an adapter (never the whole source in memory), processes them
 * in bounded batches, records every problem in IMPORT_ERRORS instead of stopping,
 * and logs the whole run in pmd.ingestion_run (the DATA_COLLECTION_LOG).
 *
 * Gate: only an ACTIVE, enabled source can run. A source registered as blocked
 * (a marketplace with no agreed access route, a CAPTCHA-protected government site)
 * is refused here, whatever adapter code exists.
 */
import { resolveConfig, type PmdConfigOverrides } from "../config";
import type { Sql } from "../db";
import { normalizeStaged } from "../normalize";
import { ensureReferenceData, loadManualCategoryMapper } from "../reference-data";
import { ParseError, type SourceAdapter } from "../sources/adapter";
import { chainMappers } from "../taxonomy/mapper";
import type { RawRecord } from "../types";
import { emptyCounters, loadRecord, type LoadContext, type PendingError, type RunCounters } from "./load";
import { markUnseenOffers, recomputeProductStatus } from "./offers";
import { refreshQuality } from "./quality";

export type RunMode = "PILOT" | "INITIAL_FULL" | "INCREMENTAL" | "IMPORT" | "BACKFILL";

export interface RunOptions {
  mode: RunMode;
  limit?: number;
  since?: Date;
  batchSize?: number;
  triggeredBy?: string;
  config?: PmdConfigOverrides;
  log?: (message: string) => void;
}

export interface RunSummary {
  runId: number;
  sourceKey: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  counters: RunCounters;
  durationMs: number;
  errorSummary: string | null;
}

export class SourceNotEnabledError extends Error {
  constructor(public readonly sourceKey: string, public readonly status: string, public readonly enabled: boolean) {
    super(
      `Source "${sourceKey}" cannot run: status is ${status}${enabled ? "" : " and it is not enabled"}. ` +
        "Only an ACTIVE, enabled source may collect data - see its legal basis and access route in the source register.",
    );
    this.name = "SourceNotEnabledError";
  }
}

async function flushErrors(sql: Sql, runId: number, sourceId: number, errors: PendingError[]): Promise<void> {
  if (errors.length === 0) return;
  const rows = errors.splice(0).map((e) => ({
    run_id: runId,
    source_id: sourceId,
    source_record_id: e.sourceRecordId,
    stage: e.stage,
    severity: e.severity,
    error_code: e.code,
    message: e.message.slice(0, 1000),
    raw_excerpt: e.excerpt ? sql.json({ excerpt: e.excerpt }) : null,
  }));
  await sql`INSERT INTO pmd.import_error ${sql(rows as never, ...(Object.keys(rows[0]) as never[]))}`;
}

async function saveCounters(sql: Sql, runId: number, c: RunCounters): Promise<void> {
  await sql`
    UPDATE pmd.ingestion_run SET
      records_read = ${c.recordsRead}, records_staged = ${c.recordsStaged}, records_unchanged = ${c.recordsUnchanged},
      products_created = ${c.productsCreated}, products_linked = ${c.productsLinked}, products_updated = ${c.productsUpdated},
      offers_upserted = ${c.offersUpserted}, price_changes = ${c.priceChanges}, review_queued = ${c.reviewQueued},
      conflicts_opened = ${c.conflictsOpened}, error_count = ${c.errorCount}
    WHERE run_id = ${runId}`;
}

export async function runIngestion(sql: Sql, adapter: SourceAdapter, opts: RunOptions): Promise<RunSummary> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const cfg = resolveConfig(opts.config);
  const key = adapter.definition.key;

  const ref = await ensureReferenceData(sql);
  const sourceId = ref.sourceIdByKey.get(key);
  if (sourceId == null) throw new Error(`source "${key}" is not in the register (pmd.source)`);

  const [src] = await sql<{ status: string; enabled: boolean }[]>`SELECT status, enabled FROM pmd.source WHERE source_id = ${sourceId}`;
  if (src.status !== "ACTIVE" || !src.enabled) throw new SourceNotEnabledError(key, src.status, src.enabled);

  const [run] = await sql<{ run_id: number; started_at: Date }[]>`
    INSERT INTO pmd.ingestion_run (source_id, run_mode, triggered_by, params)
    VALUES (${sourceId}, ${opts.mode}, ${opts.triggeredBy ?? "system"}, ${sql.json({ limit: opts.limit ?? null, since: opts.since?.toISOString() ?? null } as never)})
    RETURNING run_id, started_at`;
  const runId = run.run_id;

  const counters = emptyCounters();
  const errors: PendingError[] = [];
  const touched = new Set<number>();
  const manual = await loadManualCategoryMapper(sql, key);
  const categoryMapper = chainMappers(manual, adapter.categoryMapper);

  await sql`SELECT pmd.ensure_price_history_partitions(date_trunc('month', now())::date, (now() + interval '3 months')::date)`;

  const ctx: LoadContext = {
    sql, cfg, ref, adapter, sourceId, runId, counters, touched, errors,
    brandCache: new Map(), manufacturerCache: new Map(),
  };

  const flush = async () => {
    const ids = [...touched];
    touched.clear();
    await flushErrors(sql, runId, sourceId, errors);
    if (ids.length) {
      await recomputeProductStatus(sql, ids);
      await refreshQuality(sql, ref, cfg, ids);
    }
    await saveCounters(sql, runId, counters);
  };

  const batchSize = opts.batchSize ?? cfg.batchSize;
  let inBatch = 0;
  let failure: Error | null = null;

  try {
    for await (const raw of adapter.extract({ limit: opts.limit, since: opts.since, log })) {
      counters.recordsRead++;
      // Sanitise first: nothing downstream - raw storage, error excerpts, logs - ever sees personal data.
      const payload = adapter.sanitize ? adapter.sanitize(raw.payload) : raw.payload;
      const rec: RawRecord = { ...raw, payload };
      try {
        const staged = adapter.parse(rec);
        const normalized = normalizeStaged(staged, { categoryMapper });
        for (const i of normalized.issues) {
          // NAME_MISSING is reported by the loader (it may still be able to attach the record to a known product).
          if (i.severity === "INFO" || i.code === "NAME_MISSING") continue;
          errors.push({
            stage: "NORMALIZE",
            severity: i.severity === "ERROR" ? "ERROR" : "WARNING",
            code: i.code,
            message: `${i.field}: ${i.message}`,
            sourceRecordId: raw.sourceProductId,
            excerpt: i.original ?? null,
          });
          if (i.severity === "ERROR") counters.errorCount++;
        }
        await loadRecord(ctx, { raw: rec, staged, normalized });
      } catch (e) {
        counters.errorCount += e instanceof ParseError && e.severity === "WARNING" ? 0 : 1;
        errors.push(
          e instanceof ParseError
            ? { stage: "PARSE", severity: e.severity, code: e.code, message: e.message, sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(payload).slice(0, 400) }
            : { stage: "LOAD", severity: "ERROR", code: "LOAD_FAILED", message: (e as Error).message, sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(payload).slice(0, 400) },
        );
      }
      if (++inBatch >= batchSize) {
        inBatch = 0;
        await flush();
        log(`run ${runId}: ${counters.recordsRead} read, ${counters.productsCreated} created, ${counters.productsLinked} linked, ${counters.errorCount} errors`);
      }
    }

    // Only a COMPLETE snapshot can say "not seen this time" - and then only downgrades offers.
    if (adapter.supportsFullSnapshot && !opts.limit && (opts.mode === "INITIAL_FULL" || opts.mode === "INCREMENTAL")) {
      const gone = await markUnseenOffers(sql, sourceId, run.started_at, runId);
      gone.forEach((id) => touched.add(id));
    }
  } catch (e) {
    failure = e as Error;
  }

  await flush();
  await sql`SELECT pmd.refresh_dashboard()`;

  const status: RunSummary["status"] = failure ? "FAILED" : counters.errorCount > 0 ? "PARTIAL" : "SUCCEEDED";
  await sql`
    UPDATE pmd.ingestion_run SET status = ${status}, finished_at = now(), error_summary = ${failure ? failure.message.slice(0, 1000) : null}
    WHERE run_id = ${runId}`;
  if (!failure) {
    await sql`UPDATE pmd.source SET last_success_at = now(), last_run_products = ${counters.recordsRead} WHERE source_id = ${sourceId}`;
  }

  const summary: RunSummary = { runId, sourceKey: key, status, counters, durationMs: Date.now() - started, errorSummary: failure?.message ?? null };
  if (failure) throw Object.assign(failure, { summary });
  return summary;
}
