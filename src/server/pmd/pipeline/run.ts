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
import { loadBatch } from "./batch";
import { emptyCounters, loadRecord, type LoadContext, type LoadInput, type PendingError, type RunCounters } from "./load";
import { markUnseenOffers, recomputeProductStatus } from "./offers";
import { refreshQuality } from "./quality";

/** FNV-1a: a stable, cheap spread of a routing key over the workers. */
function routeTo(key: string, workers: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % workers;
}

export type RunMode = "PILOT" | "INITIAL_FULL" | "INCREMENTAL" | "IMPORT" | "BACKFILL";

export interface RunOptions {
  mode: RunMode;
  limit?: number;
  since?: Date;
  batchSize?: number;
  triggeredBy?: string;
  config?: PmdConfigOverrides;
  log?: (message: string) => void;
  /**
   * "batch" (default): unchanged and brand-new records are handled in bulk, everything else by the per-record loader.
   * "record": every record through the per-record loader - the reference behaviour, kept for verification and diagnosis.
   */
  loader?: "batch" | "record";
  /** Parallel workers (default: config.concurrency = 1). Needs a connection pool of at least workers + 1. */
  workers?: number;
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
  const loader = opts.loader ?? "batch";
  const workers = Math.max(1, Math.floor(opts.workers ?? cfg.concurrency));
  let failure: Error | null = null;
  let unseenMarked = false;

  /** One record through the reference loader. A failure is recorded against the record, never thrown: the run goes on. */
  const loadOne = async (input: LoadInput): Promise<void> => {
    try {
      await loadRecord(ctx, input);
    } catch (e) {
      counters.errorCount += 1;
      errors.push({
        stage: "LOAD", severity: "ERROR", code: "LOAD_FAILED", message: (e as Error).message,
        sourceRecordId: input.raw.sourceProductId, excerpt: JSON.stringify(input.raw.payload).slice(0, 400),
      });
    }
  };

  /** A batch: in bulk where that is safe, record by record everywhere else - then the per-batch bookkeeping. */
  const runBatch = async (batch: LoadInput[]): Promise<void> => {
    if (loader === "batch") {
      try {
        await loadBatch(ctx, batch, loadOne);
      } catch {
        // The bulk path failed before it changed anything it counted (its writes roll back): run the batch the reference way.
        for (const input of batch) await loadOne(input);
      }
    } else {
      for (const input of batch) await loadOne(input);
    }
    await flush();
    log(`run ${runId}: ${counters.recordsRead} read, ${counters.productsCreated} created, ${counters.productsLinked} linked, ${counters.errorCount} errors`);
  };

  // Records are routed to a worker by brand (else barcode, else name), so everything that could be a duplicate of
  // something else is handled by ONE worker, in stream order - the same guarantee the per-brand lock gave one record at a time.
  const buffers: LoadInput[][] = Array.from({ length: workers }, () => []);
  const chains: Promise<void>[] = Array.from({ length: workers }, () => Promise.resolve());
  const inFlight: number[] = new Array<number>(workers).fill(0);
  const dispatch = async (w: number): Promise<void> => {
    const batch = buffers[w];
    if (batch.length === 0) return;
    buffers[w] = [];
    inFlight[w]++;
    chains[w] = chains[w]
      .then(() => runBatch(batch))
      .catch((e) => {
        failure ??= e as Error;
      })
      .finally(() => {
        inFlight[w]--;
      });
    if (inFlight[w] >= 2) await chains[w]; // do not run ahead of a busy worker: memory stays bounded
  };

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
        const w = workers === 1 ? 0 : routeTo(normalized.brand?.key ?? normalized.gtin?.gtin14 ?? normalized.coreName, workers);
        buffers[w].push({ raw: rec, staged, normalized });
        if (buffers[w].length >= batchSize) await dispatch(w);
      } catch (e) {
        counters.errorCount += e instanceof ParseError && e.severity === "WARNING" ? 0 : 1;
        errors.push(
          e instanceof ParseError
            ? { stage: "PARSE", severity: e.severity, code: e.code, message: e.message, sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(payload).slice(0, 400) }
            : { stage: "LOAD", severity: "ERROR", code: "LOAD_FAILED", message: (e as Error).message, sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(payload).slice(0, 400) },
        );
      }
    }
    for (let w = 0; w < workers; w++) await dispatch(w);
    await Promise.all(chains);
    if (failure) throw failure;

    // Only a COMPLETE snapshot can say "not seen this time" - and then only downgrades offers.
    if (adapter.supportsFullSnapshot && !opts.limit && (opts.mode === "INITIAL_FULL" || opts.mode === "INCREMENTAL")) {
      const gone = await markUnseenOffers(sql, sourceId, run.started_at, runId);
      gone.forEach((id) => touched.add(id));
      unseenMarked = gone.length > 0;
    }
  } catch (e) {
    failure = e as Error;
  }

  await flush();
  // The snapshot is a full aggregate: at a million products it takes seconds, so a run that changed nothing
  // (an incremental pass over an unchanged source) does not rebuild it.
  const c = counters;
  const changedSomething = c.recordsStaged + c.productsCreated + c.productsLinked + c.productsUpdated + c.offersUpserted + c.priceChanges + c.reviewQueued + c.conflictsOpened + c.errorCount > 0 || unseenMarked;
  try {
    if (changedSomething) await sql`SELECT pmd.refresh_dashboard()`;
  } catch (e) {
    // The dashboard is a display snapshot rebuilt after every run: failing to refresh it must never fail a run whose work is done.
    log(`dashboard snapshot not refreshed: ${(e as Error).message}`);
  }

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
