/**
 * Lifecycle status models (feature F1) — server side.
 *
 * The lifecycle status of shops, riders and subscriptions is derived and
 * logged by database triggers (migration 0042; rules in lib/status-models.ts).
 * This module reads the log and refreshes the one date-dependent status: a
 * subscription whose pause window starts or ends today changes lifecycle
 * without any row being written, so the daily order run touches those rows.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { StatusEntity } from "@/lib/status-models";
import { db, type DbClient } from "@/server/db";
import { statusChanges, type StatusChange } from "@/server/db/schema";

/** Re-derives subscriptions whose stored lifecycle no longer matches today. Returns how many changed. */
export async function refreshSubscriptionLifecycles(client: DbClient = db): Promise<number> {
  const result = await client.execute(sql`
    UPDATE subscriptions SET status_actor_id = NULL
     WHERE lifecycle_status IS DISTINCT FROM lifecycle_subscription(status, pause_from, pause_until)`);
  return (result as unknown as { count?: number }).count ?? 0;
}

export async function listStatusChanges(
  filter: { entityType?: StatusEntity; entityId?: string; limit?: number } = {},
): Promise<StatusChange[]> {
  const where: SQL[] = [];
  if (filter.entityType) where.push(eq(statusChanges.entityType, filter.entityType));
  if (filter.entityId) where.push(eq(statusChanges.entityId, filter.entityId));
  return db
    .select()
    .from(statusChanges)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(statusChanges.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
}

/** True when an error is the trigger refusing a lifecycle transition. */
export function isLifecycleTransitionError(error: unknown): boolean {
  const e = (error as { cause?: { hint?: string } })?.cause ?? (error as { hint?: string });
  return e?.hint === "lifecycle_transition";
}
