/**
 * Large-scale, batched, resumable ingestion jobs (batch-2026-10 WS-D, F9.1.4).
 *
 *   createIngestJob   validates every row (template checks, GTIN check digit), flags duplicate
 *                     GTINs inside the file, and stages the whole input ONCE in
 *                     pmd_ingest_job_rows — the job's durable input. Nothing is loaded yet.
 *   processIngestJob  takes a lease, then repeatedly: the next `batch_size` rows after `cursor`
 *                     → the existing pipeline (runIngestion: raw_record staging, GTIN de-dup by
 *                     match/engine.ts) → images → ONE transaction that marks the rows and moves
 *                     the cursor (the checkpoint). A crash before a checkpoint re-runs only that
 *                     batch, which the pipeline treats as unchanged records, so a job interrupted
 *                     mid-way resumes from the last committed batch with nothing duplicated.
 *   processDueJobs    the worker: /api/cron/pmd-ingest calls it every minute (a few batches per
 *                     job per tick, rule pmdSources.ingestBatchesPerTick); a new job also gets
 *                     an immediate kick after its creation. Choice recorded in the report.
 *   errorFileCsv      every refused row with its reasons, as CSV (the error file).
 *   jobProgress       what the progress screen polls.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  pmdIngestJobRows,
  pmdIngestJobs,
  pmdManufacturerAccounts,
  pmdRecordAttributions,
  type PmdIngestJob,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import type { ImageFetcher } from "@/server/product-import/image-fetch";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

import { appSql, type Sql } from "./db";
import { analyzeGtin } from "./normalize/identifiers";
import { gs1Definition } from "./data-sources/gs1-datakart";
import { manufacturerDataSource, missingRequiredHeadings, toTemplateRow, validateTemplateRow, type RowOutcome } from "./data-sources/manufacturer";
import { offLookupSource } from "./data-sources/open-food-facts";
import { DataSourceDisabledError, type ProductDataSource } from "./data-sources/types";
import { storeRecordImages } from "./images";
import type { ObjectStore } from "./object-store";
import { runIngestion } from "./pipeline/run";
import { upsertSources } from "./reference-data";
import { parseDelimited } from "./sources/delimited";
import { createRowsAdapter } from "./sources/adapters/rows";
import { parseXlsxWithHeader } from "./sources/xlsx";
import type { StagedProduct } from "./types";

type JobKind = PmdIngestJob["kind"];

export interface JobActor {
  id: string | null;
  role: UserRole | null;
}

/* ------------------------------------------------------------ file parsing */

export interface ParsedFile {
  headings: string[];
  rows: { rowNumber: number; cells: Record<string, string> }[];
}

/** CSV (comma, semicolon or tab — detected from the heading line) or .xlsx. */
export async function parseUploadedFile(bytes: Buffer, fileName: string): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    const dir = await mkdtemp(path.join(tmpdir(), "pmd-upload-"));
    const file = path.join(dir, `${randomUUID()}.xlsx`);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      const rows: ParsedFile["rows"] = [];
      let headings: string[] = [];
      for await (const r of parseXlsxWithHeader(file)) {
        if (headings.length === 0) headings = Object.keys(r.row);
        rows.push({ rowNumber: r.rowNumber, cells: r.row });
      }
      return { headings, rows };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (!lower.endsWith(".csv") && !lower.endsWith(".txt") && !lower.endsWith(".tsv")) {
    throw validationFailed("Upload the template as .csv or .xlsx.");
  }
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  const delimiter = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: ParsedFile["rows"] = [];
  let headings: string[] | null = null;
  let n = 0;
  const chunks = (async function* () {
    yield text;
  })();
  for await (const cells of parseDelimited(chunks, { delimiter })) {
    n += 1;
    if (!headings) {
      headings = cells.map((c) => c.trim());
      continue;
    }
    const obj: Record<string, string> = {};
    headings.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
    rows.push({ rowNumber: n, cells: obj });
  }
  return { headings: headings ?? [], rows };
}

/* -------------------------------------------------------------- data source */

/** The data source a job's records belong to (built again at every batch, so a restart needs nothing in memory). */
export async function dataSourceForJob(job: Pick<PmdIngestJob, "kind" | "sourceKey" | "manufacturerAccountId">): Promise<ProductDataSource> {
  if (job.kind === "MANUFACTURER_UPLOAD" || job.kind === "MANUFACTURER_API") {
    const [account] = job.manufacturerAccountId
      ? await db.select().from(pmdManufacturerAccounts).where(eq(pmdManufacturerAccounts.id, job.manufacturerAccountId))
      : [];
    if (!account) throw notFound("Manufacturer");
    return manufacturerDataSource(account);
  }
  if (job.kind === "OPEN_FOOD_FACTS") return offLookupSource();
  if (job.kind === "GS1_DATAKART") {
    const definition = gs1Definition(job.sourceKey === "gs1_datakart" ? "REAL" : "MOCK");
    return {
      key: definition.key,
      label: definition.name,
      kind: "GS1",
      definition: () => definition,
      isEnabled: async () => (await getRule("pmdSources")).gs1Enabled,
      licence: async () =>
        definition.key === "gs1_datakart"
          ? { name: "GS1 India DataKart (agreement)", url: "https://gs1india.org/datakart/datakart-premium", attribution: "Product data: GS1 India DataKart." }
          : { name: "Test data", url: null, attribution: "MOCK GS1 DataKart record (test data, not from GS1)." },
      adapter: (rows) => createRowsAdapter({ definition, rows, collectionMethod: definition.key === "gs1_datakart" ? "OFFICIAL_API" : "MOCK" }),
    };
  }
  throw validationFailed(`No data source for job kind ${job.kind}.`);
}

/* ---------------------------------------------------------------- creation */

export interface StagedInputRow {
  rowNumber: number;
  raw: Record<string, string> | null;
  outcome: RowOutcome;
}

/** Template rows (from a file or the API) → validated input rows. */
export function validateRows(
  rows: { rowNumber: number; cells: Record<string, unknown> }[],
  defaults: { brand?: string | null; manufacturer?: string | null } = {},
): StagedInputRow[] {
  return rows.map((r) => {
    const raw = Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, v == null ? "" : String(v)]));
    return { rowNumber: r.rowNumber, raw, outcome: validateTemplateRow(toTemplateRow(r.cells), defaults) };
  });
}

/** Rows already in the staged vocabulary (GS1 / OFF look-ups). */
export function stagedToInputRows(found: StagedProduct[]): StagedInputRow[] {
  return found.map((s, i) => ({
    rowNumber: i + 1,
    raw: { gtin: s.gtin ?? "", name: s.name ?? "", brand: s.brand ?? "" },
    outcome: { ok: true, gtin14: analyzeGtin(s.gtin)?.gtin14 ?? null, sourceProductId: s.sourceProductId, staged: s, errorCode: null, errorMessage: null },
  }));
}

export interface CreateJobInput {
  kind: JobKind;
  source: ProductDataSource;
  manufacturerAccountId?: string | null;
  fileName: string;
  rows: StagedInputRow[];
  createdVia?: "PORTAL" | "API" | "STAFF" | "LOOKUP";
  /** The file's column headings in their order (the error file repeats them). */
  headings?: string[];
  /** Default: a kick right after creation unless PMD_INGEST_AUTORUN=off. */
  autoStart?: boolean;
}

export async function createIngestJob(input: CreateJobInput, actor: JobActor, sql: Sql = appSql()): Promise<PmdIngestJob> {
  const rules = await getRule("pmdSources");
  if (!(await input.source.isEnabled())) throw new DataSourceDisabledError(input.source.key, `${input.source.label} is switched off.`);
  if (input.rows.length === 0) throw validationFailed("The file has no product rows.");
  if (input.rows.length > rules.maxRowsPerFile) {
    throw validationFailed(`One file can hold at most ${rules.maxRowsPerFile.toLocaleString("en-IN")} rows; split it into smaller files.`);
  }

  // GTIN de-duplication inside the file: the first row with a GTIN wins.
  const firstRowByGtin = new Map<string, number>();
  const rows = input.rows.map((r) => {
    const o = r.outcome;
    if (o.ok && o.gtin14) {
      const first = firstRowByGtin.get(o.gtin14);
      if (first !== undefined) {
        return { ...r, status: "DUPLICATE" as const, errorCode: "DUPLICATE_GTIN_IN_FILE", errorMessage: `Same GTIN as row ${first}; this row was skipped.` };
      }
      firstRowByGtin.set(o.gtin14, r.rowNumber);
      return { ...r, status: "VALID" as const, errorCode: null, errorMessage: null };
    }
    return { ...r, status: "INVALID" as const, errorCode: o.errorCode, errorMessage: o.errorMessage };
  });
  const byCode: Record<string, number> = {};
  for (const r of rows) if (r.errorCode) byCode[r.errorCode] = (byCode[r.errorCode] ?? 0) + 1;
  const valid = rows.filter((r) => r.status === "VALID").length;

  // The source must be in the register before its first run; manufacturer / look-up sources are not in the shipped list.
  await upsertSources(sql, [input.source.definition()]);

  const job = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(pmdIngestJobs)
      .values({
        kind: input.kind,
        sourceKey: input.source.definition().key,
        manufacturerAccountId: input.manufacturerAccountId ?? null,
        fileName: input.fileName.slice(0, 200),
        status: valid > 0 ? "QUEUED" : "PARTIAL",
        totalRows: rows.length,
        validRows: valid,
        invalidRows: rows.length - valid,
        batchSize: rules.ingestBatchSize,
        createdBy: actor.id,
        createdVia: input.createdVia ?? "PORTAL",
        finishedAt: valid > 0 ? null : new Date(),
        report: {
          validation: { total: rows.length, valid, invalid: rows.filter((r) => r.status === "INVALID").length, duplicates: rows.filter((r) => r.status === "DUPLICATE").length, byCode },
          worker: "batched; resumable from the last committed batch; driven by /api/cron/pmd-ingest and a kick at creation",
          headings: input.headings ?? null,
        },
      })
      .returning();
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(pmdIngestJobRows).values(
        rows.slice(i, i + 1000).map((r) => ({
          jobId: created.id,
          rowNumber: r.rowNumber,
          sourceProductId: r.outcome.sourceProductId,
          gtin14: r.outcome.gtin14,
          payload: r.status === "VALID" ? (r.outcome.staged as unknown as Record<string, unknown>) : null,
          raw: r.raw,
          status: r.status,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
        })),
      );
    }
    return created;
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_INGEST_JOB_CREATED,
    entityType: "pmd_ingest_job",
    entityId: job.id,
    newValue: { kind: job.kind, sourceKey: job.sourceKey, fileName: job.fileName, total: job.totalRows, valid, byCode, via: job.createdVia },
  });
  if (input.autoStart !== false && process.env.PMD_INGEST_AUTORUN !== "off" && valid > 0) {
    setTimeout(() => void processIngestJob(job.id).catch((e) => console.error("[pmd-ingest] kick failed", job.id, e)), 0).unref?.();
  }
  return job;
}

/* -------------------------------------------------------------- processing */

export interface ProcessOptions {
  /** Batches to run in this call (default rule pmdSources.ingestBatchesPerTick). */
  maxBatches?: number;
  workerId?: string;
  leaseSeconds?: number;
  /** Test hooks. */
  fetcher?: ImageFetcher;
  store?: ObjectStore;
  /** Called after a batch has been loaded and before its checkpoint commits (a crash there re-runs the batch). */
  beforeCheckpoint?: (batchIndex: number) => void | Promise<void>;
  sql?: Sql;
}

export interface JobProgress {
  id: string;
  kind: JobKind;
  sourceKey: string;
  fileName: string | null;
  status: PmdIngestJob["status"];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  processedRows: number;
  stagedRows: number;
  failedRows: number;
  cursor: number;
  batchesDone: number;
  imagesStored: number;
  imagesFailed: number;
  percent: number;
  lastError: string | null;
  report: Record<string, unknown>;
  createdAt: Date;
  finishedAt: Date | null;
  manufacturerAccountId: string | null;
}

export function toProgress(job: PmdIngestJob): JobProgress {
  const work = Math.max(1, job.validRows);
  const done = job.status === "SUCCEEDED" || job.status === "PARTIAL" ? work : Math.min(work, job.stagedRows + job.failedRows);
  return {
    id: job.id,
    kind: job.kind,
    sourceKey: job.sourceKey,
    fileName: job.fileName,
    status: job.status,
    totalRows: job.totalRows,
    validRows: job.validRows,
    invalidRows: job.invalidRows,
    processedRows: job.processedRows,
    stagedRows: job.stagedRows,
    failedRows: job.failedRows,
    cursor: job.cursor,
    batchesDone: job.batchesDone,
    imagesStored: job.imagesStored,
    imagesFailed: job.imagesFailed,
    percent: Math.round((done / work) * 100),
    lastError: job.lastError,
    report: job.report,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    manufacturerAccountId: job.manufacturerAccountId,
  };
}

async function claim(jobId: string, worker: string, leaseSeconds: number): Promise<PmdIngestJob | null> {
  const [job] = await db
    .update(pmdIngestJobs)
    .set({
      status: "RUNNING",
      leaseOwner: worker,
      leaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
      startedAt: sql`coalesce(${pmdIngestJobs.startedAt}, now())`,
      attempts: sql`${pmdIngestJobs.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pmdIngestJobs.id, jobId),
        inArray(pmdIngestJobs.status, ["QUEUED", "RUNNING"]),
        or(isNull(pmdIngestJobs.leaseUntil), lt(pmdIngestJobs.leaseUntil, sql`now()`), eq(pmdIngestJobs.leaseOwner, worker)),
      ),
    )
    .returning();
  return job ?? null;
}

const MAX_ATTEMPTS = 20;

export async function processIngestJob(jobId: string, options: ProcessOptions = {}): Promise<JobProgress> {
  const worker = options.workerId ?? `pmd-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseSeconds = options.leaseSeconds ?? 600;
  const rules = await getRule("pmdSources");
  const maxBatches = options.maxBatches ?? rules.ingestBatchesPerTick;
  const sqlClient = options.sql ?? appSql();

  const claimed = await claim(jobId, worker, leaseSeconds);
  if (!claimed) {
    const [current] = await db.select().from(pmdIngestJobs).where(eq(pmdIngestJobs.id, jobId));
    if (!current) throw notFound("Import");
    return toProgress(current);
  }
  let job: PmdIngestJob = claimed;
  const source = await dataSourceForJob(job);
  const licence = await source.licence();

  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await db
        .select()
        .from(pmdIngestJobRows)
        .where(and(eq(pmdIngestJobRows.jobId, job.id), gt(pmdIngestJobRows.rowNumber, job.cursor)))
        .orderBy(asc(pmdIngestJobRows.rowNumber))
        .limit(job.batchSize);
      if (rows.length === 0) return toProgress(await finish(job));

      const validRows = rows.filter((r) => r.status === "VALID" && r.payload);
      const failed = new Map<number, { code: string; message: string }>();
      let runId: number | null = null;
      let images = { stored: 0, failed: 0 };
      if (validRows.length > 0) {
        const staged = validRows.map((r) => r.payload as unknown as StagedProduct);
        try {
          const summary = await runIngestion(sqlClient, source.adapter(staged), {
            mode: "IMPORT",
            triggeredBy: `pmd-job:${job.id}`,
            batchSize: Math.min(500, job.batchSize),
          });
          runId = summary.runId;
        } catch (error) {
          const summary = (error as { summary?: { runId: number } }).summary;
          if (!summary) throw error;
          runId = summary.runId; // the run recorded its own errors; rows without one still loaded
        }
        const errs = await sqlClient<{ source_record_id: string | null; error_code: string; message: string }[]>`
          SELECT source_record_id, error_code, message FROM pmd.import_error WHERE run_id = ${runId} AND severity = 'ERROR'`;
        const rowBySource = new Map(validRows.map((r) => [r.sourceProductId, r.rowNumber]));
        for (const e of errs) {
          const rowNumber = e.source_record_id ? rowBySource.get(e.source_record_id) : undefined;
          if (rowNumber !== undefined && !failed.has(rowNumber)) failed.set(rowNumber, { code: e.error_code, message: e.message });
        }
        const loaded = validRows.filter((r) => !failed.has(r.rowNumber));
        if (rules.imagesEnabled && rules.imagesPerRow > 0) {
          images = await storeRecordImages(
            loaded
              .map((r) => ({ sourceKey: job!.sourceKey, sourceProductId: r.sourceProductId ?? String(r.rowNumber), gtin14: r.gtin14, urls: ((r.payload as { images?: string[] }).images ?? []) }))
              .filter((i) => i.urls.length > 0),
            { maxEdgePx: rules.imageMaxEdgePx, maxBytes: rules.imageMaxBytes, perRecord: rules.imagesPerRow, jobId: job.id, fetcher: options.fetcher, store: options.store },
          );
        }
        if (licence?.attribution && loaded.length) {
          await db
            .insert(pmdRecordAttributions)
            .values(
              loaded.map((r) => ({
                sourceKey: job!.sourceKey,
                sourceProductId: r.sourceProductId ?? String(r.rowNumber),
                gtin14: r.gtin14,
                attribution: licence.attribution!,
                licenceName: licence.name,
                licenceUrl: licence.url,
                recordUrl: (r.payload as { sourceUrl?: string | null }).sourceUrl ?? null,
              })),
            )
            .onConflictDoNothing();
        }
      }

      await options.beforeCheckpoint?.(job.batchesDone);

      // The checkpoint: row outcomes and the cursor commit together.
      const lastRow = rows[rows.length - 1].rowNumber;
      const stagedCount = validRows.length - failed.size;
      job = await db.transaction(async (tx) => {
        const okIds = validRows.filter((r) => !failed.has(r.rowNumber)).map((r) => r.rowNumber);
        if (okIds.length) {
          await tx.update(pmdIngestJobRows).set({ status: "STAGED" }).where(and(eq(pmdIngestJobRows.jobId, jobId), inArray(pmdIngestJobRows.rowNumber, okIds)));
        }
        for (const [rowNumber, e] of failed) {
          await tx
            .update(pmdIngestJobRows)
            .set({ status: "FAILED", errorCode: e.code, errorMessage: e.message.slice(0, 500) })
            .where(and(eq(pmdIngestJobRows.jobId, jobId), eq(pmdIngestJobRows.rowNumber, rowNumber)));
        }
        const [updated] = await tx
          .update(pmdIngestJobs)
          .set({
            cursor: lastRow,
            processedRows: sql`${pmdIngestJobs.processedRows} + ${rows.length}`,
            stagedRows: sql`${pmdIngestJobs.stagedRows} + ${stagedCount}`,
            failedRows: sql`${pmdIngestJobs.failedRows} + ${failed.size}`,
            imagesStored: sql`${pmdIngestJobs.imagesStored} + ${images.stored}`,
            imagesFailed: sql`${pmdIngestJobs.imagesFailed} + ${images.failed}`,
            batchesDone: sql`${pmdIngestJobs.batchesDone} + 1`,
            runIds: runId != null ? sql`array_append(${pmdIngestJobs.runIds}, ${runId}::bigint)` : sql`${pmdIngestJobs.runIds}`,
            leaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(and(eq(pmdIngestJobs.id, jobId), eq(pmdIngestJobs.leaseOwner, worker)))
          .returning();
        if (!updated) throw conflict("Another worker took over this import.");
        return updated;
      });
    }
    // Batches left: release the lease so the next tick (any worker) continues.
    const [released] = await db
      .update(pmdIngestJobs)
      .set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(pmdIngestJobs.id, jobId), eq(pmdIngestJobs.leaseOwner, worker)))
      .returning();
    return toProgress(released ?? job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [failedJob] = await db
      .update(pmdIngestJobs)
      .set({
        lastError: message.slice(0, 1000),
        leaseOwner: null,
        leaseUntil: null,
        status: (job?.attempts ?? 0) >= MAX_ATTEMPTS ? "FAILED" : "RUNNING",
        finishedAt: (job?.attempts ?? 0) >= MAX_ATTEMPTS ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(pmdIngestJobs.id, jobId))
      .returning();
    throw Object.assign(error instanceof Error ? error : new Error(message), { progress: failedJob ? toProgress(failedJob) : null });
  }
}

async function finish(job: PmdIngestJob): Promise<PmdIngestJob> {
  const status = job.failedRows > 0 || job.invalidRows > 0 ? "PARTIAL" : "SUCCEEDED";
  const [done] = await db
    .update(pmdIngestJobs)
    .set({ status, finishedAt: new Date(), leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(pmdIngestJobs.id, job.id), eq(pmdIngestJobs.status, "RUNNING")))
    .returning();
  if (!done) {
    const [current] = await db.select().from(pmdIngestJobs).where(eq(pmdIngestJobs.id, job.id));
    return current;
  }
  await recordAudit({
    actorId: null,
    action: AUDIT_ACTIONS.PMD_INGEST_JOB_FINISHED,
    entityType: "pmd_ingest_job",
    entityId: job.id,
    newValue: { status, staged: done.stagedRows, failed: done.failedRows, invalid: done.invalidRows, images: done.imagesStored, runs: done.runIds.length },
  });
  await emitEvent({
    type: "pmd.import_finished",
    subjectId: job.id,
    payload: {
      createdBy: job.createdBy,
      fileName: job.fileName ?? "Product import",
      staged: done.stagedRows,
      failed: done.failedRows + done.invalidRows,
      status,
      jobId: job.id,
      url: job.manufacturerAccountId ? `/manufacturer/jobs/${job.id}` : `/admin/product-browser/jobs/${job.id}`,
    },
    idempotencyKey: `pmd-import-finished:${job.id}`,
  }).catch((e) => console.error("[pmd-ingest] finish event failed", e));
  return done;
}

/** The worker: every runnable job gets up to `ingestBatchesPerTick` batches. */
export async function processDueJobs(options: { maxJobs?: number } & Omit<ProcessOptions, "maxBatches"> = {}): Promise<{ jobs: number; progressed: JobProgress[]; errors: string[] }> {
  const due = await db
    .select({ id: pmdIngestJobs.id })
    .from(pmdIngestJobs)
    .where(and(inArray(pmdIngestJobs.status, ["QUEUED", "RUNNING"]), or(isNull(pmdIngestJobs.leaseUntil), lt(pmdIngestJobs.leaseUntil, sql`now()`))))
    .orderBy(asc(pmdIngestJobs.createdAt))
    .limit(options.maxJobs ?? 5);
  const progressed: JobProgress[] = [];
  const errors: string[] = [];
  for (const { id } of due) {
    try {
      progressed.push(await processIngestJob(id, options));
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { jobs: due.length, progressed, errors };
}

/* ------------------------------------------------------------------ reads */

export async function getJob(jobId: string): Promise<PmdIngestJob> {
  const [job] = await db.select().from(pmdIngestJobs).where(eq(pmdIngestJobs.id, jobId));
  if (!job) throw notFound("Import");
  return job;
}

export async function jobProgress(jobId: string): Promise<JobProgress & { errorsByCode: Record<string, number> }> {
  const job = await getJob(jobId);
  const codes = await db
    .select({ code: pmdIngestJobRows.errorCode, n: sql<number>`count(*)::int` })
    .from(pmdIngestJobRows)
    .where(and(eq(pmdIngestJobRows.jobId, jobId), sql`${pmdIngestJobRows.errorCode} IS NOT NULL`))
    .groupBy(pmdIngestJobRows.errorCode);
  return { ...toProgress(job), errorsByCode: Object.fromEntries(codes.map((c) => [c.code ?? "", c.n])) };
}

export async function listJobs(filter: { manufacturerAccountId?: string | null; limit?: number } = {}): Promise<JobProgress[]> {
  const rows = await db
    .select()
    .from(pmdIngestJobs)
    .where(filter.manufacturerAccountId ? eq(pmdIngestJobs.manufacturerAccountId, filter.manufacturerAccountId) : undefined)
    .orderBy(desc(pmdIngestJobs.createdAt))
    .limit(filter.limit ?? 50);
  return rows.map(toProgress);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas (CSV injection) and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The error file: every refused row with its reason and the row as uploaded. */
export async function errorFileCsv(jobId: string): Promise<string> {
  const job = await getJob(jobId);
  const lines: string[] = [];
  const stored = job.report.headings;
  let headings: string[] | null = Array.isArray(stored) ? (stored as string[]) : null;
  let after = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(pmdIngestJobRows)
      .where(and(eq(pmdIngestJobRows.jobId, jobId), gt(pmdIngestJobRows.rowNumber, after), inArray(pmdIngestJobRows.status, ["INVALID", "DUPLICATE", "FAILED"])))
      .orderBy(asc(pmdIngestJobRows.rowNumber))
      .limit(2000);
    if (rows.length === 0) break;
    for (const r of rows) {
      const raw = r.raw ?? {};
      headings ??= Object.keys(raw);
      lines.push([r.rowNumber, r.status, r.errorCode ?? "", r.errorMessage ?? "", ...headings.map((h) => raw[h] ?? "")].map(csvCell).join(","));
    }
    after = rows[rows.length - 1].rowNumber;
  }
  const header = ["Row", "Status", "Error code", "Reason", ...(headings ?? [])].map(csvCell).join(",");
  return `﻿${[header, ...lines].join("\r\n")}\r\n`;
}

/** Puts a FAILED / stopped job back in the queue (it resumes from its cursor). */
export async function resumeJob(jobId: string, actor: JobActor): Promise<JobProgress> {
  const [job] = await db
    .update(pmdIngestJobs)
    .set({ status: "QUEUED", leaseOwner: null, leaseUntil: null, attempts: 0, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(pmdIngestJobs.id, jobId), inArray(pmdIngestJobs.status, ["FAILED", "RUNNING", "QUEUED"])))
    .returning();
  if (!job) throw conflict("This import has finished; start a new one to load the file again.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PMD_INGEST_JOB_CREATED, entityType: "pmd_ingest_job", entityId: jobId, newValue: { resumed: true, cursor: job.cursor } });
  return toProgress(job);
}

/* ----------------------------------------------------- manufacturer upload */

/** A manufacturer's file (portal) or rows (API) → a validated, staged job. */
export async function createManufacturerJob(
  input: {
    accountId: string;
    via: "PORTAL" | "API";
    fileName: string;
    file?: Buffer;
    rows?: Record<string, unknown>[];
    autoStart?: boolean;
  },
  actor: JobActor,
): Promise<{ job: JobProgress; missingHeadings: string[] }> {
  const [account] = await db.select().from(pmdManufacturerAccounts).where(eq(pmdManufacturerAccounts.id, input.accountId));
  if (!account) throw notFound("Manufacturer");
  let parsed: ParsedFile;
  if (input.file) parsed = await parseUploadedFile(input.file, input.fileName);
  else parsed = { headings: Object.keys(input.rows?.[0] ?? {}), rows: (input.rows ?? []).map((cells, i) => ({ rowNumber: i + 1, cells: cells as Record<string, string> })) };
  const missing = missingRequiredHeadings(parsed.headings).filter((h) => !(h === "Brand" && account.brandNames.length === 1));
  if (missing.length) throw validationFailed(`The file is missing required column(s): ${missing.join(", ")}. Use the template.`, { missingHeadings: missing });
  const defaults = { brand: account.brandNames.length === 1 ? account.brandNames[0] : null, manufacturer: account.name };
  const job = await createIngestJob(
    {
      kind: input.via === "API" ? "MANUFACTURER_API" : "MANUFACTURER_UPLOAD",
      source: manufacturerDataSource(account),
      manufacturerAccountId: account.id,
      fileName: input.fileName,
      rows: validateRows(parsed.rows, defaults),
      headings: parsed.headings,
      createdVia: input.via,
      autoStart: input.autoStart,
    },
    actor,
  );
  return { job: toProgress(job), missingHeadings: [] };
}
