/**
 * Every call to the GSP goes through here (billing v2, docs/billing §9.10,
 * §10): a request id, a per-shop rate limit, retries with backoff when the
 * GSP is unavailable, and one row in gsp_call_log per call (operation, shop,
 * who asked, outcome, attempts, time taken, a short message — never tokens,
 * OTPs or personal data). A GSP that stays down surfaces as UNAVAILABLE, and
 * the screens offer the download / upload fallback (§9.11).
 */
import { randomUUID } from "node:crypto";

import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { gspCallLog } from "@/server/db/schema";
import { GspError } from "@/server/gst/gsp/types";

/** Calls per shop per minute before GoKesari holds back (GSPs throttle per GSTIN). */
export const GSP_CALLS_PER_MINUTE = 30;
const BACKOFF_MS = [300, 900];

export interface GspCallContext {
  operation: string;
  provider: string;
  shopId?: string | null;
  actorId?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callGsp<T>(ctx: GspCallContext, fn: () => Promise<T>): Promise<T> {
  if (ctx.shopId) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gspCallLog)
      .where(and(eq(gspCallLog.shopId, ctx.shopId), gte(gspCallLog.createdAt, new Date(Date.now() - 60_000))));
    if (n >= GSP_CALLS_PER_MINUTE) throw new GspError("UNAVAILABLE", "Too many GST portal requests in a minute — try again shortly.", "RATE_LIMIT");
  }
  const requestId = randomUUID();
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown = null;
  for (;;) {
    attempts += 1;
    try {
      const result = await fn();
      await log(ctx, requestId, attempts, started, null);
      return result;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof GspError && error.retryable;
      if (!retryable || attempts > BACKOFF_MS.length) break;
      await sleep(BACKOFF_MS[attempts - 1]);
    }
  }
  await log(ctx, requestId, attempts, started, lastError);
  throw lastError;
}

async function log(ctx: GspCallContext, requestId: string, attempts: number, started: number, error: unknown): Promise<void> {
  const e = error instanceof GspError ? error : error ? new GspError("UNAVAILABLE", error instanceof Error ? error.message : String(error)) : null;
  try {
    await db.insert(gspCallLog).values({
      shopId: ctx.shopId ?? null,
      operation: ctx.operation,
      provider: ctx.provider,
      requestId,
      actorId: ctx.actorId ?? null,
      outcome: e ? "ERROR" : "OK",
      errorCode: e?.code ?? null,
      message: e ? `${e.message}${e.detail ? ` (${e.detail})` : ""}`.slice(0, 500) : null,
      attempts,
      durationMs: Date.now() - started,
    });
  } catch (logError) {
    // The call's own outcome stands; a log failure is only reported.
    console.error("[gsp] call log write failed", ctx.operation, logError);
  }
}

export async function recentGspCalls(shopId: string | null, limit = 50) {
  return db
    .select()
    .from(gspCallLog)
    .where(shopId ? eq(gspCallLog.shopId, shopId) : sql`true`)
    .orderBy(sql`${gspCallLog.createdAt} desc`)
    .limit(limit);
}
