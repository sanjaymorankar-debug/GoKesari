/**
 * The integration sync outbox (Module 2).
 *
 * Every push (invoice, credit note) and pull is an integration_jobs row:
 *   - queued in the SAME transaction as the event that causes it (an order
 *     delivered, a refund), with a unique idempotency key — queuing twice is a
 *     no-op, so a retried delivery or refund never queues a second invoice;
 *   - run straight after commit (API software), or picked up within a second
 *     by the shop's Tally connector, which holds a long-poll open;
 *   - claimed with SKIP LOCKED and a lease: two runners never take the same
 *     job, and a runner that dies leaves it to be reclaimed after the lease;
 *   - retried with backoff when the failure is temporary; after N attempts,
 *     or at once when the owner must fix something, it is DEAD: the owner is
 *     told, sees it on the error screen and presses Retry after fixing it.
 * No schedule drives any of this. The every-minute safety-net sweep
 * (/api/cron/integration-sync) only re-runs jobs whose retry time came while
 * no request was around to run them.
 */
import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  integrationJobs,
  integrationSyncLog,
  shopIntegrations,
  shops,
  type IntegrationJob,
  type ShopIntegration,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { CanonicalCreditNote, CanonicalInvoice } from "./canonical";
import { decryptCredentials, encryptCredentials, CREDENTIALS_KEY_VERSION } from "./credentials";
import { buildPushDocument } from "./documents";
import { asIntegrationError, describeError, IntegrationError } from "./errors";
import { applyPulledItems } from "./pull";
import { API_PROVIDERS, adapterFor, isApiAdapter, isConnectorAdapter } from "./registry";
import type { AdapterContext, ConnectorStep, PushResult } from "./types";

/** Seconds before retry n (1-based); the last value repeats. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
const LEASE_SECONDS = 180;

type JobKind = IntegrationJob["kind"];

/* ---------------------------------------------------------------- log */

export async function logSync(
  integration: Pick<ShopIntegration, "id" | "shopId">,
  entry: { level: "INFO" | "WARN" | "ERROR"; event: string; message: string; jobId?: string | null; detail?: Record<string, unknown> },
  client: DbClient = db,
): Promise<void> {
  await client.insert(integrationSyncLog).values({
    shopId: integration.shopId,
    integrationId: integration.id,
    jobId: entry.jobId ?? null,
    level: entry.level,
    event: entry.event,
    message: entry.message,
    detail: entry.detail ?? null,
  });
}

/* ------------------------------------------------------------ queueing */

/** The shop's connection, unless disconnected. */
export async function liveIntegration(shopId: string, client: DbClient = db): Promise<ShopIntegration | null> {
  const [row] = await client
    .select()
    .from(shopIntegrations)
    .where(and(eq(shopIntegrations.shopId, shopId), ne(shopIntegrations.status, "DISCONNECTED")))
    .limit(1);
  return row ?? null;
}

export interface EnqueueInput {
  integration: Pick<ShopIntegration, "id" | "shopId">;
  kind: JobKind;
  idempotencyKey: string;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}

/** Queues a job once per key. `created` false when that key was already queued. */
export async function enqueueJob(input: EnqueueInput, client: DbClient = db): Promise<{ id: string; created: boolean }> {
  const [row] = await client
    .insert(integrationJobs)
    .values({
      shopId: input.integration.shopId,
      integrationId: input.integration.id,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: integrationJobs.idempotencyKey })
    .returning({ id: integrationJobs.id });
  if (row) {
    scheduleDispatch(client);
    wakeConnector(input.integration.id, client);
    return { id: row.id, created: true };
  }
  const [existing] = await client.select({ id: integrationJobs.id }).from(integrationJobs).where(eq(integrationJobs.idempotencyKey, input.idempotencyKey));
  return { id: existing.id, created: false };
}

const pushEnabled = (integration: ShopIntegration, what: "invoices" | "creditNotes") =>
  ((integration.config.push ?? {}) as Record<string, unknown>)[what] !== false;

/** Order delivered → its invoice goes to the shop's software (if the shop has a connection). */
export async function enqueueInvoicePush(invoice: { id: string; shopId: string }, client: DbClient = db): Promise<string | null> {
  const integration = await liveIntegration(invoice.shopId, client);
  if (!integration || !pushEnabled(integration, "invoices")) return null;
  const job = await enqueueJob(
    { integration, kind: "PUSH_INVOICE", idempotencyKey: `push-invoice:${invoice.id}:${integration.id}`, subjectType: "tax_invoice", subjectId: invoice.id },
    client,
  );
  return job.id;
}

/** Refund after delivery → its credit note goes to the shop's software. */
export async function enqueueCreditNotePush(note: { id: string; shopId: string }, client: DbClient = db): Promise<string | null> {
  const integration = await liveIntegration(note.shopId, client);
  if (!integration || !pushEnabled(integration, "creditNotes")) return null;
  const job = await enqueueJob(
    { integration, kind: "PUSH_CREDIT_NOTE", idempotencyKey: `push-credit-note:${note.id}:${integration.id}`, subjectType: "credit_note", subjectId: note.id },
    client,
  );
  return job.id;
}

/* ---------------------------------------------------------- dispatching */

/**
 * Connectors waiting in a long-poll on this server, woken when a job for
 * their connection is queued (so Tally gets it within a second). Another
 * server process does not hear it; its waiting connectors find the job at
 * their next check a few seconds later.
 */
const connectorWaiters = new Map<string, Set<() => void>>();

export function waitForConnectorWork(integrationId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const set = connectorWaiters.get(integrationId) ?? new Set();
    connectorWaiters.set(integrationId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) connectorWaiters.delete(integrationId);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

export function wakeConnector(integrationId: string, client: DbClient = db): void {
  const wake = () => connectorWaiters.get(integrationId)?.forEach((fn) => fn());
  if (client === db) wake();
  else setTimeout(wake, 1_500).unref?.();
}

/**
 * Runs due API jobs shortly after the caller's transaction commits (a job
 * queued inside a transaction is invisible until then). INTEGRATION_AUTODISPATCH=off
 * turns this off (tests run the dispatcher themselves).
 */
export function scheduleDispatch(client: DbClient = db): void {
  if (process.env.INTEGRATION_AUTODISPATCH === "off") return;
  const run = () => void dispatchDueJobs().catch((error) => console.error("[integrations] dispatch failed", error));
  if (client === db) setTimeout(run, 0).unref?.();
  else setTimeout(run, 2_000).unref?.();
}

/** The adapter context for a job: decrypted secrets, a way to save refreshed ones, and job progress. */
export function contextFor(integration: ShopIntegration, job: IntegrationJob | null, fetchFn: typeof fetch = fetch): AdapterContext {
  const ctx: AdapterContext = {
    integration,
    config: integration.config,
    credentials: integration.credentialsEncrypted ? decryptCredentials(integration.credentialsEncrypted) : {},
    fetch: fetchFn,
    state: (job?.state ?? {}) as Record<string, unknown>,
    async saveCredentials(next) {
      await db
        .update(shopIntegrations)
        .set({ credentialsEncrypted: encryptCredentials(next), keyVersion: CREDENTIALS_KEY_VERSION, updatedAt: new Date() })
        .where(eq(shopIntegrations.id, integration.id));
    },
    async checkpoint(next) {
      ctx.state = next;
      if (job) await db.update(integrationJobs).set({ state: next, updatedAt: new Date() }).where(eq(integrationJobs.id, job.id));
    },
  };
  return ctx;
}

/** Claims due jobs of API software (or one integration's) for this server. */
async function claimApiJobs(limit: number, integrationId?: string): Promise<IntegrationJob[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: integrationJobs.id })
      .from(integrationJobs)
      .innerJoin(shopIntegrations, eq(shopIntegrations.id, integrationJobs.integrationId))
      .where(
        and(
          inArray(shopIntegrations.provider, API_PROVIDERS),
          inArray(shopIntegrations.status, ["ACTIVE", "ERROR"]),
          integrationId ? eq(integrationJobs.integrationId, integrationId) : undefined,
          or(
            and(inArray(integrationJobs.status, ["PENDING", "FAILED"]), lte(integrationJobs.nextAttemptAt, new Date())),
            and(eq(integrationJobs.status, "CLAIMED"), lte(integrationJobs.leaseUntil, new Date())),
          ),
        ),
      )
      .orderBy(integrationJobs.nextAttemptAt)
      .limit(limit)
      .for("update", { of: integrationJobs, skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(integrationJobs)
      .set({
        status: "CLAIMED",
        claimedBy: "server",
        leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
        attempts: sql`${integrationJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(inArray(integrationJobs.id, due.map((d) => d.id)))
      .returning();
  });
}

export interface DispatchSummary {
  ran: number;
  succeeded: number;
  failed: number;
  dead: number;
}

/** Runs due API jobs now. Safe to call concurrently (SKIP LOCKED). */
export async function dispatchDueJobs(
  options: { limit?: number; integrationId?: string; fetch?: typeof fetch } = {},
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { ran: 0, succeeded: 0, failed: 0, dead: 0 };
  const jobs = await claimApiJobs(options.limit ?? 20, options.integrationId);
  for (const job of jobs) {
    summary.ran += 1;
    const outcome = await runApiJob(job, options.fetch ?? fetch);
    summary[outcome] += 1;
  }
  return summary;
}

async function runApiJob(job: IntegrationJob, fetchFn: typeof fetch): Promise<"succeeded" | "failed" | "dead"> {
  const [integration] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, job.integrationId));
  const adapter = integration ? adapterFor(integration.provider) : null;
  if (!integration || !adapter || !isApiAdapter(adapter)) {
    return failJob(job, new IntegrationError("NOT_CONFIGURED", "The connection no longer exists."));
  }
  try {
    const ctx = contextFor(integration, job, fetchFn);
    if (job.kind === "PUSH_INVOICE" || job.kind === "PUSH_CREDIT_NOTE") {
      const doc = await buildPushDocument(integration.id, job.kind, job.subjectId!);
      const result =
        job.kind === "PUSH_INVOICE"
          ? await adapter.pushInvoice(ctx, doc as CanonicalInvoice)
          : await adapter.pushCreditNote(ctx, doc as CanonicalCreditNote);
      await completeJob(job, integration, result, { document: doc as unknown as Record<string, unknown> });
    } else if (job.kind === "PULL_ITEMS") {
      const items = await adapter.pullItems(ctx);
      const pulled = await applyPulledItems(integration, items);
      await completeJob(job, integration, { externalRef: `${items.length} items`, created: false }, { pulled: pulled as unknown as Record<string, unknown> });
    } else {
      const message = await adapter.testConnection(ctx);
      await completeJob(job, integration, { externalRef: "ok", created: false }, { message });
    }
    return "succeeded";
  } catch (error) {
    return failJob(job, asIntegrationError(error));
  }
}

/* ------------------------------------------------------------ outcomes */

const LABEL: Record<JobKind, string> = {
  PUSH_INVOICE: "Invoice",
  PUSH_CREDIT_NOTE: "Credit note",
  PULL_ITEMS: "Item sync",
  TEST_CONNECTION: "Connection test",
};

function describeJob(job: IntegrationJob): string {
  const doc = job.payload.document as { number?: string } | undefined;
  return `${LABEL[job.kind]}${doc?.number ? ` ${doc.number}` : ""}`;
}

export async function completeJob(
  job: IntegrationJob,
  integration: ShopIntegration,
  result: PushResult,
  payloadExtra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [done] = await tx
      .update(integrationJobs)
      .set({
        status: "SUCCEEDED",
        externalRef: result.externalRef,
        payload: { ...job.payload, ...payloadExtra },
        leaseUntil: null,
        errorCode: null,
        errorMessage: null,
        errorDetail: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(integrationJobs.id, job.id), ne(integrationJobs.status, "SUCCEEDED")))
      .returning();
    if (!done) return;
    const isPush = job.kind === "PUSH_INVOICE" || job.kind === "PUSH_CREDIT_NOTE";
    await tx
      .update(shopIntegrations)
      .set({
        ...(isPush ? { lastPushAt: now } : job.kind === "PULL_ITEMS" ? { lastPullAt: now } : {}),
        lastErrorCode: null,
        lastErrorAt: null,
        status: sql`CASE WHEN ${shopIntegrations.status} = 'ERROR' THEN 'ACTIVE' ELSE ${shopIntegrations.status} END`,
        updatedAt: now,
      })
      .where(eq(shopIntegrations.id, integration.id));
    const message = isPush
      ? result.created
        ? `${describeJob(done)} sent.`
        : `${describeJob(done)} was already in your software (nothing duplicated).`
      : `${describeJob(done)} done.`;
    await logSync(integration, { level: "INFO", event: `${job.kind.toLowerCase()}.succeeded`, message, jobId: job.id, detail: { externalRef: result.externalRef, created: result.created } }, tx);
  });
}

/** Records a failure: retry later (temporary) or DEAD (needs the owner, or out of attempts). */
export async function failJob(job: IntegrationJob, error: IntegrationError): Promise<"failed" | "dead"> {
  const attempts = job.attempts;
  const dead = !error.retryable || attempts >= job.maxAttempts;
  const delay = BACKOFF_SECONDS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_SECONDS.length - 1)];
  const info = describeError(error.code);
  const now = new Date();
  const integration = await db.transaction(async (tx) => {
    await tx
      .update(integrationJobs)
      .set({
        status: dead ? "DEAD" : "FAILED",
        nextAttemptAt: new Date(now.getTime() + delay * 1000),
        leaseUntil: null,
        claimedBy: null,
        errorCode: error.code,
        errorMessage: info.message,
        errorDetail: error.detail?.slice(0, 4000) ?? null,
        updatedAt: now,
      })
      .where(eq(integrationJobs.id, job.id));
    const [row] = await tx
      .update(shopIntegrations)
      .set({
        lastErrorCode: error.code,
        lastErrorAt: now,
        ...(error.code === "AUTH_FAILED" || error.code === "TOKEN_EXPIRED" ? { status: "ERROR" as const } : {}),
        updatedAt: now,
      })
      .where(eq(shopIntegrations.id, job.integrationId))
      .returning();
    if (row) {
      await logSync(
        row,
        {
          level: dead ? "ERROR" : "WARN",
          event: `${job.kind.toLowerCase()}.${dead ? "dead" : "failed"}`,
          message: dead ? `${describeJob(job)} could not be sent: ${info.message}` : `${describeJob(job)} failed, trying again: ${info.message}`,
          jobId: job.id,
          detail: { code: error.code, attempt: attempts, detail: error.detail?.slice(0, 1000) ?? null },
        },
        tx,
      );
    }
    return row ?? null;
  });
  if (dead && integration && job.kind !== "TEST_CONNECTION") {
    const [shop] = await db.select({ name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, job.shopId));
    if (shop) {
      await emitEvent({
        type: "integration.job_dead",
        subjectId: job.id,
        payload: { shopName: shop.name, ownerId: shop.ownerId, what: describeJob(job), reason: info.message, fix: info.fix },
        idempotencyKey: `integration-dead:${job.id}:${job.updatedAt.getTime()}`,
      }).catch((e) => console.error("[integrations] dead-job notice failed", e));
    }
  }
  return dead ? "dead" : "failed";
}

/** The owner (after fixing the cause) or support sends a failed job again. */
export async function retryJob(shopId: string, jobId: string, actor: { id: string; role: UserRole }): Promise<void> {
  const [row] = await db
    .update(integrationJobs)
    .set({ status: "PENDING", attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, claimedBy: null, updatedAt: new Date() })
    .where(and(eq(integrationJobs.id, jobId), eq(integrationJobs.shopId, shopId), inArray(integrationJobs.status, ["DEAD", "FAILED"])))
    .returning();
  if (!row) {
    const [exists] = await db.select({ status: integrationJobs.status }).from(integrationJobs).where(and(eq(integrationJobs.id, jobId), eq(integrationJobs.shopId, shopId)));
    if (!exists) throw notFound("Sync entry");
    throw conflict(`This entry is ${exists.status.toLowerCase()} — only a failed entry can be retried.`);
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.INTEGRATION_JOB_RETRIED, entityType: "integration_job", entityId: jobId });
  scheduleDispatch();
  wakeConnector(row.integrationId);
}

/* ------------------------------------------------- the Tally connector */

export interface ConnectorWork extends ConnectorStep {
  jobId: string;
  kind: JobKind;
}

/** Claims this connector's due jobs and returns the first request of each. */
export async function claimConnectorWork(integration: ShopIntegration, tokenId: string, limit = 5): Promise<ConnectorWork[]> {
  const adapter = adapterFor(integration.provider);
  if (!isConnectorAdapter(adapter)) return [];
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: integrationJobs.id })
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.integrationId, integration.id),
          or(
            and(inArray(integrationJobs.status, ["PENDING", "FAILED"]), lte(integrationJobs.nextAttemptAt, new Date())),
            and(eq(integrationJobs.status, "CLAIMED"), lte(integrationJobs.leaseUntil, new Date())),
          ),
        ),
      )
      .orderBy(integrationJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(integrationJobs)
      .set({
        status: "CLAIMED",
        claimedBy: tokenId,
        leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
        attempts: sql`${integrationJobs.attempts} + 1`,
        // Every attempt starts with the lookup: after a lost reply the voucher
        // may already be in Tally, which does not refuse a repeated number.
        state: {},
        updatedAt: new Date(),
      })
      .where(inArray(integrationJobs.id, due.map((d) => d.id)))
      .returning();
  });
  const work: ConnectorWork[] = [];
  for (const job of claimed) {
    try {
      const prepared = await withDocument(job);
      const step = adapter.stepFor(prepared, contextFor(integration, prepared));
      work.push({ jobId: job.id, kind: job.kind, ...step });
    } catch (error) {
      await failJob(job, asIntegrationError(error));
    }
  }
  return work;
}

/** Push jobs carry the current canonical document (built now, so new item matches count). */
async function withDocument(job: IntegrationJob): Promise<IntegrationJob> {
  if (job.kind !== "PUSH_INVOICE" && job.kind !== "PUSH_CREDIT_NOTE") return job;
  const doc = await buildPushDocument(job.integrationId, job.kind, job.subjectId!);
  const payload = doc as unknown as Record<string, unknown>;
  await db.update(integrationJobs).set({ payload }).where(eq(integrationJobs.id, job.id));
  return { ...job, payload };
}

export type ConnectorResult =
  | { ok: true; stepId: string; response: string }
  | { ok: false; stepId: string; errorCode: "TALLY_NOT_RUNNING" | "TALLY_COMPANY_NOT_OPEN" | "UNREACHABLE" | "INTERNAL"; detail?: string };

/** The connector reports a step's outcome; the reply is the job's next request, if any. */
export async function submitConnectorResult(
  integration: ShopIntegration,
  tokenId: string,
  jobId: string,
  result: ConnectorResult,
): Promise<{ done: boolean; next?: ConnectorWork; error?: string }> {
  const [job] = await db
    .select()
    .from(integrationJobs)
    .where(and(eq(integrationJobs.id, jobId), eq(integrationJobs.integrationId, integration.id)));
  if (!job) throw notFound("Job");
  if (job.status !== "CLAIMED" || job.claimedBy !== tokenId) throw conflict("This job is not held by this connector (it may have timed out).");
  const adapter = adapterFor(integration.provider);
  if (!isConnectorAdapter(adapter)) throw conflict("Not a connector integration.");
  if (!result.ok) {
    await failJob(job, new IntegrationError(result.errorCode, result.detail ?? null));
    return { done: true, error: result.errorCode };
  }
  try {
    const ctx = contextFor(integration, job);
    if (result.stepId === "ITEMS" && job.kind === "PULL_ITEMS") {
      const items = adapter.parseItems(result.response);
      const pulled = await applyPulledItems(integration, items);
      await completeJob(job, integration, { externalRef: `${items.length} items`, created: false }, { pulled: pulled as unknown as Record<string, unknown> });
      return { done: true };
    }
    const outcome = adapter.applyStepResult(job, ctx, result.stepId, result.response);
    if (outcome.kind === "done") {
      await db.update(integrationJobs).set({ state: outcome.state }).where(eq(integrationJobs.id, job.id));
      await completeJob(job, integration, outcome.result, { document: job.payload });
      return { done: true };
    }
    const [next] = await db
      .update(integrationJobs)
      .set({ state: outcome.state, leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`, updatedAt: new Date() })
      .where(eq(integrationJobs.id, job.id))
      .returning();
    const step = adapter.stepFor(next, contextFor(integration, next));
    return { done: false, next: { jobId: job.id, kind: job.kind, ...step } };
  } catch (error) {
    await failJob(job, asIntegrationError(error));
    return { done: true, error: asIntegrationError(error).code };
  }
}

/* -------------------------------------------------------------- views */

export async function listJobs(shopId: string, options: { status?: IntegrationJob["status"][]; limit?: number } = {}) {
  return db
    .select()
    .from(integrationJobs)
    .where(and(eq(integrationJobs.shopId, shopId), options.status ? inArray(integrationJobs.status, options.status) : undefined))
    .orderBy(desc(integrationJobs.createdAt))
    .limit(options.limit ?? 100);
}

export async function listSyncLog(shopId: string, limit = 200) {
  return db.select().from(integrationSyncLog).where(eq(integrationSyncLog.shopId, shopId)).orderBy(desc(integrationSyncLog.createdAt)).limit(limit);
}
