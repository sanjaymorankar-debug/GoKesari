/**
 * GoKesari Health: the patient's timeline (health.timeline) — one row per event, written in the same
 * transaction as the change it records, so the record views update the moment it commits.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { healthCounters, healthTimeline, type HealthTimelineRow } from "@/server/db/schema";
import type { TimelineKind } from "@/lib/health/constants";

export interface TimelineInput {
  patientId: string;
  occurredAt: Date;
  kind: TimelineKind;
  title: string;
  summary?: string | null;
  providerName?: string | null;
  providerMemberId?: string | null;
  providerShopId?: string | null;
  refType: string;
  refId: string;
  meta?: Record<string, unknown>;
}

/** Adds (or refreshes) the timeline row for one source record. */
export async function addTimeline(client: DbClient, input: TimelineInput): Promise<void> {
  const values = {
    patientId: input.patientId,
    occurredAt: input.occurredAt,
    kind: input.kind,
    title: input.title.slice(0, 200),
    summary: input.summary?.slice(0, 600) ?? null,
    providerName: input.providerName?.slice(0, 160) ?? null,
    providerMemberId: input.providerMemberId ?? null,
    providerShopId: input.providerShopId ?? null,
    refType: input.refType,
    refId: input.refId,
    meta: input.meta ?? {},
  };
  await client
    .insert(healthTimeline)
    .values(values)
    .onConflictDoUpdate({
      target: [healthTimeline.patientId, healthTimeline.refType, healthTimeline.refId, healthTimeline.kind],
      set: { occurredAt: values.occurredAt, title: values.title, summary: values.summary, providerName: values.providerName, meta: values.meta, hiddenAt: null },
    });
}

export async function timelineFor(patientId: string, opts: { kind?: TimelineKind | null; q?: string | null; limit?: number } = {}, client: DbClient = db): Promise<HealthTimelineRow[]> {
  const where = [eq(healthTimeline.patientId, patientId), isNull(healthTimeline.hiddenAt)];
  if (opts.kind) where.push(eq(healthTimeline.kind, opts.kind));
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase().replace(/[%_]/g, "")}%`;
    where.push(sql`(lower(${healthTimeline.title}) like ${like} or lower(coalesce(${healthTimeline.summary}, '')) like ${like} or lower(coalesce(${healthTimeline.providerName}, '')) like ${like})`);
  }
  return client
    .select()
    .from(healthTimeline)
    .where(and(...where))
    .orderBy(desc(healthTimeline.occurredAt), desc(healthTimeline.createdAt))
    .limit(Math.min(opts.limit ?? 500, 2000));
}

/** Next number in a series ("RX-2026", "MED-2026", "RENT-2026", "PRIME-2026-27"); call inside a transaction. */
export async function nextNumber(client: DbClient, series: string): Promise<number> {
  const [row] = await client
    .insert(healthCounters)
    .values({ series, nextNo: 2 })
    .onConflictDoUpdate({ target: healthCounters.series, set: { nextNo: sql`${healthCounters.nextNo} + 1` } })
    .returning({ nextNo: healthCounters.nextNo });
  return row.nextNo - 1;
}
