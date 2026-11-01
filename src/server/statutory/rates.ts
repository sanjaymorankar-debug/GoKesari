/**
 * Statutory settings with effective dates (batch-2026-10 WS-E).
 *
 * Choice recorded: a dated table (`statutory_rates`, platform) rather than a
 * dated rule — each tax setting has its own effective dates, legal reference
 * and a "confirmed by the CA" flag, and payout maths picks the row in force
 * on each supply's date, so a rate change in the middle of a payout cycle
 * applies from its day only. Rows are seeded by migration 0083 with
 * confirmed_by_ca = false; the admin screen (/admin/statutory) shows that
 * prominently until the owner's CA confirms each row.
 *
 * Keys:
 *   GST_TCS_SEC52            rateBp; params.applyToUnregistered
 *   IT_TDS_194O              rateBp; params.noPanRateBp, exemptIndividualHufUpToPaise, baseExcludesGst, sectionLabel
 *   GST_S95_RESTAURANT       rateBp; params.appliesToShopTypes (disabled by default)
 *   GST_S95_LOCAL_DELIVERY   rateBp (disabled by default)
 *   UNREGISTERED_SELLER_RULES params.tcsOnUnregistered, tdsOnUnregistered, interStateAllowed
 *   PLATFORM_FEE_GST         params.rateBpByFeeType (GST on GoKesari's fees)
 */
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { addDays, assertIsoDate, type IsoDate } from "@/lib/dates";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { statutoryRates, type StatutoryRate, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const STATUTORY_KEYS = [
  "GST_TCS_SEC52",
  "IT_TDS_194O",
  "GST_S95_RESTAURANT",
  "GST_S95_LOCAL_DELIVERY",
  "UNREGISTERED_SELLER_RULES",
  "PLATFORM_FEE_GST",
] as const;
export type StatutoryKey = (typeof STATUTORY_KEYS)[number];

interface Actor {
  id: string;
  role: UserRole;
}

/** A moment as an IST calendar date. */
export function istDay(at: Date): IsoDate {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** The row in force on `day` (enabled or not — callers check `enabled`), or null. */
export async function statutoryRateOn(key: StatutoryKey, day: IsoDate, client: DbClient = db): Promise<StatutoryRate | null> {
  const [row] = await client
    .select()
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.key, key),
        lte(statutoryRates.effectiveFrom, day),
        or(isNull(statutoryRates.effectiveTo), gte(statutoryRates.effectiveTo, day)),
      ),
    )
    .orderBy(desc(statutoryRates.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/**
 * Looks rows up once per (key, day) for a batch computation (a payout cycle
 * reads the same few rows for every order).
 */
export function statutoryResolver(client: DbClient = db) {
  const cache = new Map<string, Promise<StatutoryRate | null>>();
  return (key: StatutoryKey, day: IsoDate) => {
    const k = `${key}|${day}`;
    if (!cache.has(k)) cache.set(k, statutoryRateOn(key, day, client));
    return cache.get(k)!;
  };
}
export type StatutoryResolver = ReturnType<typeof statutoryResolver>;

export async function listStatutoryRates(): Promise<StatutoryRate[]> {
  return db.select().from(statutoryRates).orderBy(asc(statutoryRates.key), desc(statutoryRates.effectiveFrom));
}

export async function countUnconfirmedStatutoryRates(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(statutoryRates)
    .where(and(eq(statutoryRates.confirmedByCa, false), or(isNull(statutoryRates.effectiveTo), gte(statutoryRates.effectiveTo, istDay(new Date())))));
  return row?.n ?? 0;
}

export const statutoryRateInput = z.object({
  key: z.enum(STATUTORY_KEYS),
  label: z.string().trim().min(3).max(200),
  enabled: z.boolean(),
  rateBp: z.number().int().min(0).max(10_000).nullable(),
  params: z.record(z.string(), z.unknown()).default({}),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  legalReference: z.string().max(1000).nullable().optional(),
  sourceUrl: z.string().url().max(500).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});
export type StatutoryRateInput = z.infer<typeof statutoryRateInput>;

/**
 * Adds a dated row. The row that was open on that day is closed the day
 * before, so exactly one row is in force on any day. A new row is never
 * CA-confirmed until someone records the confirmation.
 */
export async function addStatutoryRate(input: StatutoryRateInput, actor: Actor): Promise<StatutoryRate> {
  const parsed = statutoryRateInput.parse(input);
  const from = assertIsoDate(parsed.effectiveFrom);
  return db.transaction(async (tx) => {
    const [clash] = await tx
      .select({ id: statutoryRates.id })
      .from(statutoryRates)
      .where(and(eq(statutoryRates.key, parsed.key), eq(statutoryRates.effectiveFrom, from)));
    if (clash) throw conflict("A row for this setting already starts on that day — edit it instead.");
    const closed = await tx
      .update(statutoryRates)
      .set({ effectiveTo: addDays(from, -1), updatedBy: actor.id, updatedAt: new Date() })
      .where(
        and(
          eq(statutoryRates.key, parsed.key),
          lte(statutoryRates.effectiveFrom, from),
          or(isNull(statutoryRates.effectiveTo), gte(statutoryRates.effectiveTo, from)),
        ),
      )
      .returning({ id: statutoryRates.id, effectiveFrom: statutoryRates.effectiveFrom });
    // A later row already planned stays; the new row ends the day before it.
    const [next] = await tx
      .select({ effectiveFrom: statutoryRates.effectiveFrom })
      .from(statutoryRates)
      .where(and(eq(statutoryRates.key, parsed.key), sql`${statutoryRates.effectiveFrom} > ${from}`))
      .orderBy(asc(statutoryRates.effectiveFrom))
      .limit(1);
    const [row] = await tx
      .insert(statutoryRates)
      .values({
        key: parsed.key,
        label: parsed.label,
        enabled: parsed.enabled,
        rateBp: parsed.rateBp,
        params: parsed.params,
        effectiveFrom: from,
        effectiveTo: next ? addDays(next.effectiveFrom, -1) : null,
        legalReference: parsed.legalReference ?? null,
        sourceUrl: parsed.sourceUrl ?? null,
        note: parsed.note ?? null,
        confirmedByCa: false,
        updatedBy: actor.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED,
        entityType: "statutory_rate",
        entityId: row.id,
        previousValue: closed,
        newValue: { key: row.key, rateBp: row.rateBp, enabled: row.enabled, params: row.params, effectiveFrom: row.effectiveFrom },
      },
      tx,
    );
    return row;
  });
}

export const statutoryPatchInput = z.object({
  enabled: z.boolean().optional(),
  rateBp: z.number().int().min(0).max(10_000).nullable().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(1000).nullable().optional(),
  /** Records (or withdraws) the CA's confirmation of this row. */
  confirmedByCa: z.boolean().optional(),
});

/** Edits a row in place. Changing a value withdraws the CA confirmation (it must be confirmed again). */
export async function updateStatutoryRate(id: string, patch: z.infer<typeof statutoryPatchInput>, actor: Actor): Promise<StatutoryRate> {
  const input = statutoryPatchInput.parse(patch);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(statutoryRates).where(eq(statutoryRates.id, id)).for("update");
    if (!current) throw notFound("Statutory setting");
    const valueChanged = input.enabled !== undefined || input.rateBp !== undefined || input.params !== undefined;
    if (valueChanged && input.confirmedByCa) throw validationFailed("Change the value first, then record the CA's confirmation.");
    const confirm = input.confirmedByCa;
    const [row] = await tx
      .update(statutoryRates)
      .set({
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.rateBp !== undefined ? { rateBp: input.rateBp } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(valueChanged ? { confirmedByCa: false, confirmedBy: null, confirmedAt: null } : {}),
        ...(confirm === true ? { confirmedByCa: true, confirmedBy: actor.id, confirmedAt: new Date() } : {}),
        ...(confirm === false ? { confirmedByCa: false, confirmedBy: null, confirmedAt: null } : {}),
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(statutoryRates.id, id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED,
        entityType: "statutory_rate",
        entityId: id,
        previousValue: { enabled: current.enabled, rateBp: current.rateBp, params: current.params, confirmedByCa: current.confirmedByCa },
        newValue: { enabled: row.enabled, rateBp: row.rateBp, params: row.params, confirmedByCa: row.confirmedByCa },
      },
      tx,
    );
    return row;
  });
}

/* ------------------------------------------------------- typed readers */

export interface TcsSetting {
  rateBp: number;
  applyToUnregistered: boolean;
  rowId: string;
}

export async function tcsOn(day: IsoDate, resolve: StatutoryResolver): Promise<TcsSetting | null> {
  const row = await resolve("GST_TCS_SEC52", day);
  if (!row || !row.enabled || row.rateBp == null) return null;
  return { rateBp: row.rateBp, applyToUnregistered: row.params.applyToUnregistered === true, rowId: row.id };
}

export interface TdsSetting {
  rateBp: number;
  noPanRateBp: number;
  exemptIndividualHufUpToPaise: number;
  baseExcludesGst: boolean;
  sectionLabel: string;
  rowId: string;
}

export async function tdsOn(day: IsoDate, resolve: StatutoryResolver): Promise<TdsSetting | null> {
  const row = await resolve("IT_TDS_194O", day);
  if (!row || !row.enabled || row.rateBp == null) return null;
  const p = row.params;
  return {
    rateBp: row.rateBp,
    noPanRateBp: typeof p.noPanRateBp === "number" ? p.noPanRateBp : row.rateBp,
    exemptIndividualHufUpToPaise: typeof p.exemptIndividualHufUpToPaise === "number" ? p.exemptIndividualHufUpToPaise : 0,
    baseExcludesGst: p.baseExcludesGst !== false,
    sectionLabel: typeof p.sectionLabel === "string" ? p.sectionLabel : "Sec 194-O",
    rowId: row.id,
  };
}

export interface UnregisteredRules {
  tcsOnUnregistered: boolean;
  tdsOnUnregistered: boolean;
  interStateAllowed: boolean;
}

export async function unregisteredRulesOn(day: IsoDate, resolve: StatutoryResolver): Promise<UnregisteredRules> {
  const row = await resolve("UNREGISTERED_SELLER_RULES", day);
  const p = row?.enabled ? row.params : {};
  return {
    tcsOnUnregistered: p.tcsOnUnregistered === true,
    tdsOnUnregistered: p.tdsOnUnregistered !== false,
    interStateAllowed: p.interStateAllowed === true,
  };
}

/** s.9(5) restaurant services: the rate when enabled and the shop's type is listed (5% without ITC unless params.withoutItc is false). */
export async function sec95RestaurantOn(day: IsoDate, shopType: string, resolve: StatutoryResolver): Promise<{ rateBp: number; rowId: string; withoutItc: boolean } | null> {
  const row = await resolve("GST_S95_RESTAURANT", day);
  if (!row || !row.enabled || row.rateBp == null) return null;
  const types = Array.isArray(row.params.appliesToShopTypes) ? (row.params.appliesToShopTypes as unknown[]) : [];
  return types.includes(shopType) ? { rateBp: row.rateBp, rowId: row.id, withoutItc: row.params.withoutItc !== false } : null;
}

/**
 * GST rate on one of GoKesari's fees on a day (PLATFORM_FEE_GST): the fee
 * type's rate, else the row's rate. A disabled row means 0%; no row in force
 * is an error (never a silent rate).
 */
export async function platformFeeGstRateOn(feeType: string, day: IsoDate, resolve: StatutoryResolver): Promise<number> {
  const row = await resolve("PLATFORM_FEE_GST", day);
  if (!row) throw validationFailed(`No GST rate for GoKesari's fees is in force on ${day} (Admin → Statutory, PLATFORM_FEE_GST).`);
  if (!row.enabled) return 0;
  const byType = (row.params.rateBpByFeeType ?? {}) as Record<string, unknown>;
  const rate = byType[feeType];
  return typeof rate === "number" ? rate : (row.rateBp ?? 0);
}
