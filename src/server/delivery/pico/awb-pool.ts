/**
 * Pico AWB pool (docs/pico-xpress-2026-11; doc page 2). AWB numbers are fetched in bulk from Pico and kept per
 * environment. Allocation is atomic (SELECT … FOR UPDATE SKIP LOCKED, so two bookings never get the same
 * number). The pool is refilled when a booking leaves fewer than rule picoXpress.awbRefillThreshold numbers —
 * triggered by allocation, not by a cron — or by an admin. A number is never reused: once allocated it ends as
 * USED or CANCELLED, and goes back to AVAILABLE only when Pico confirmed the order was not created.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { deliveryAwbPool, type AwbStatus, type PicoEnv } from "@/server/db/pico-schema";
import { getRule } from "@/server/services/settings";

import { fetchAwbBatch } from "./client";

export async function poolLevels(env: PicoEnv): Promise<Record<AwbStatus, number>> {
  const rows = await db
    .select({ status: deliveryAwbPool.status, n: sql<number>`count(*)::int` })
    .from(deliveryAwbPool)
    .where(eq(deliveryAwbPool.env, env))
    .groupBy(deliveryAwbPool.status);
  const out: Record<AwbStatus, number> = { AVAILABLE: 0, ALLOCATED: 0, USED: 0, CANCELLED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

let refilling: Promise<number> | null = null;

/** Fetches one batch from Pico and stores the new numbers. One refill at a time per server process. */
export async function refillPool(env: PicoEnv, count?: number): Promise<number> {
  if (refilling) return refilling;
  refilling = (async () => {
    const rules = await getRule("picoXpress");
    const awbs = await fetchAwbBatch(Math.min(1000, count ?? rules.awbFetchBatch));
    if (awbs.length === 0) return 0;
    let added = 0;
    for (let i = 0; i < awbs.length; i += 500) {
      const chunk = awbs.slice(i, i + 500);
      const inserted = await db
        .insert(deliveryAwbPool)
        .values(chunk.map((awbNumber) => ({ awbNumber, env, status: "AVAILABLE" as const })))
        .onConflictDoNothing()
        .returning({ awb: deliveryAwbPool.awbNumber });
      added += inserted.length;
    }
    return added;
  })().finally(() => {
    refilling = null;
  });
  return refilling;
}

async function availableCount(env: PicoEnv): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveryAwbPool)
    .where(and(eq(deliveryAwbPool.env, env), eq(deliveryAwbPool.status, "AVAILABLE")));
  return row?.n ?? 0;
}

/** Makes sure `needed` numbers are there before a booking (refills synchronously only when short). */
export async function ensureAwbs(env: PicoEnv, needed: number): Promise<void> {
  if ((await availableCount(env)) >= needed) return;
  await refillPool(env);
  if ((await availableCount(env)) < needed) throw new Error("No AWB numbers are available from Pico right now.");
}

/** After an allocation: refill in the background when the pool runs low. Never throws. */
export function topUpIfLow(env: PicoEnv): void {
  void (async () => {
    try {
      const rules = await getRule("picoXpress");
      if ((await availableCount(env)) < rules.awbRefillThreshold) await refillPool(env);
    } catch (error) {
      console.error("[pico] AWB pool top-up failed", error instanceof Error ? error.message : error);
    }
  })();
}

/**
 * Takes `count` numbers for one shipment, inside the caller's transaction. The first is the parent AWB.
 * Throws when the pool is short (call ensureAwbs first).
 */
export async function allocateAwbs(tx: DbClient, env: PicoEnv, count: number, orderId: string, shipmentId: string): Promise<string[]> {
  const rows = await tx
    .select({ awb: deliveryAwbPool.awbNumber })
    .from(deliveryAwbPool)
    .where(and(eq(deliveryAwbPool.env, env), eq(deliveryAwbPool.status, "AVAILABLE")))
    .orderBy(asc(deliveryAwbPool.fetchedAt), asc(deliveryAwbPool.awbNumber))
    .limit(count)
    .for("update", { skipLocked: true });
  if (rows.length < count) throw new Error("Not enough AWB numbers in the pool.");
  const now = new Date();
  for (let i = 0; i < rows.length; i++) {
    await tx
      .update(deliveryAwbPool)
      .set({ status: "ALLOCATED", orderId, shipmentId, boxNo: i + 1, allocatedAt: now })
      .where(and(eq(deliveryAwbPool.awbNumber, rows[i].awb), eq(deliveryAwbPool.status, "AVAILABLE")));
  }
  return rows.map((r) => r.awb);
}

export async function markAwbsUsed(awbs: string[], client: DbClient = db): Promise<void> {
  if (awbs.length === 0) return;
  await client
    .update(deliveryAwbPool)
    .set({ status: "USED", usedAt: new Date() })
    .where(and(inArray(deliveryAwbPool.awbNumber, awbs), eq(deliveryAwbPool.status, "ALLOCATED")));
}

/** Cancelled shipments: their numbers are retired for good. */
export async function markAwbsCancelled(awbs: string[], client: DbClient = db): Promise<void> {
  if (awbs.length === 0) return;
  await client
    .update(deliveryAwbPool)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(and(inArray(deliveryAwbPool.awbNumber, awbs), inArray(deliveryAwbPool.status, ["ALLOCATED", "USED"])));
}

/** Only when Pico confirmed the order was NOT created: the numbers may be used again. */
export async function releaseAwbs(awbs: string[], client: DbClient = db): Promise<void> {
  if (awbs.length === 0) return;
  await client
    .update(deliveryAwbPool)
    .set({ status: "AVAILABLE", orderId: null, shipmentId: null, boxNo: null, allocatedAt: null })
    .where(and(inArray(deliveryAwbPool.awbNumber, awbs), eq(deliveryAwbPool.status, "ALLOCATED")));
}
