/**
 * Rider pay plans (Rider App v2, docs/rider-app-v2-2026-11; rule riderPayPlans, OFF by default).
 *
 *  - Plans are versioned. A version is a DRAFT until published; publishing needs a simulator run
 *    on that draft and a note, and is audited (old → new). A published version is read-only.
 *  - Scope: ZONE (an HDMS delivery zone) beats CITY beats DEFAULT. One version is in force per
 *    scope: the published one with the latest effectiveFrom that has passed.
 *  - A quote is worked out when the rider sees an offer and LOCKED on the delivery when they accept
 *    (delivery_orders.quote_*). Publishing a plan never changes a quote already locked, nor an
 *    earning already written (lib/earnings-calc.ts calculatePlanEarning pays from the lock).
 *  - The flat base + per-km rate (delivery_earnings_config) was migrated into version 1 of the
 *    default plan (0210), so turning the rule on pays the same until an admin publishes a change.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { localTime, pickSlot, type SlotRule } from "@/lib/earnings-calc";
import { getEnv } from "@/lib/env";
import {
  computeQuote,
  describePlan,
  planProblems,
  type PayPlanTerms,
  type PayQuote,
  type PaySlab,
  type SurgeSource,
} from "@/lib/rider-pay-plan";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartnerEarnings,
  deliveryPartners,
  deliveryZones,
  orderFinancials,
  orders,
  riderEarningSlots,
  riderPayPlans,
  riderSurges,
  shops,
  type DeliveryOrder,
  type PayPlanScope,
  type RiderPayPlan,
  type RiderSurge,
  type SurgeReason,
  type UserRole,
} from "@/server/db/schema";
import { zoneContains } from "@/server/delivery/zones";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export async function payPlansEnabled(): Promise<boolean> {
  return (await getRule("riderPayPlans")).enabled;
}

export function toTerms(plan: RiderPayPlan): PayPlanTerms {
  return {
    id: plan.id,
    version: plan.version,
    baseFeePaise: plan.baseFeePaise,
    baseIncludedM: plan.baseIncludedM,
    slabs: plan.slabs,
    freeFirstMileM: plan.freeFirstMileM,
    firstMileRatePaise: plan.firstMileRatePaise,
    firstMileCapPaise: plan.firstMileCapPaise,
    freeWaitMin: plan.freeWaitMin,
    waitRatePaise: plan.waitRatePaise,
    waitCapPaise: plan.waitCapPaise,
    extraDropFeePaise: plan.extraDropFeePaise,
    longDistanceM: plan.longDistanceM,
    longDistanceBonusPaise: plan.longDistanceBonusPaise,
    minGuaranteePaise: plan.minGuaranteePaise,
    maxPerOrderPaise: plan.maxPerOrderPaise,
    rerouteTolerancePct: plan.rerouteTolerancePct,
  };
}

export const planLabel = (plan: Pick<RiderPayPlan, "name" | "version">) => `${plan.name} v${plan.version}`;

/* ------------------------------------------------------------ where a job is */

export interface JobPlace {
  city: string | null;
  point: { latitude: number; longitude: number } | null;
}

interface ZoneRow {
  id: string;
  city: string;
  centerLat: string;
  centerLng: string;
  radiusM: number;
  polygon: [number, number][] | null;
}

async function activeZones(client: DbClient): Promise<ZoneRow[]> {
  return client
    .select({
      id: deliveryZones.id,
      city: deliveryZones.city,
      centerLat: deliveryZones.centerLat,
      centerLng: deliveryZones.centerLng,
      radiusM: deliveryZones.radiusM,
      polygon: deliveryZones.polygon,
    })
    .from(deliveryZones)
    .where(eq(deliveryZones.status, "ACTIVE"));
}

function zonesAt(zones: readonly ZoneRow[], point: JobPlace["point"]): Set<string> {
  if (!point) return new Set();
  return new Set(zones.filter((z) => zoneContains(z, { lat: point.latitude, lng: point.longitude })).map((z) => z.id));
}

const sameCity = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/* ------------------------------------------------------------ plan in force */

/** Published versions whose effectiveFrom has passed: SCHEDULED → ACTIVE, and the version they replace → RETIRED. */
export async function promoteDuePlans(now: Date = new Date(), client: DbClient = db): Promise<number> {
  const due = await client
    .select()
    .from(riderPayPlans)
    .where(and(eq(riderPayPlans.status, "SCHEDULED"), lte(riderPayPlans.effectiveFrom, now)));
  for (const plan of due) {
    await client.transaction(async (tx) => {
      await tx
        .update(riderPayPlans)
        .set({ status: "RETIRED", retiredAt: now, updatedAt: now })
        .where(and(eq(riderPayPlans.planKey, plan.planKey), eq(riderPayPlans.status, "ACTIVE")));
      await tx.update(riderPayPlans).set({ status: "ACTIVE", updatedAt: now }).where(eq(riderPayPlans.id, plan.id));
    });
  }
  return due.length;
}

/** Every version that can price a job at `at` (ACTIVE, or SCHEDULED and due), newest first per plan. */
async function plansInForce(at: Date, client: DbClient): Promise<RiderPayPlan[]> {
  const rows = await client
    .select()
    .from(riderPayPlans)
    .where(
      and(
        inArray(riderPayPlans.status, ["ACTIVE", "SCHEDULED"]),
        or(isNull(riderPayPlans.effectiveFrom), lte(riderPayPlans.effectiveFrom, at)),
      ),
    )
    .orderBy(desc(riderPayPlans.effectiveFrom), desc(riderPayPlans.version));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.planKey) ? false : (seen.add(r.planKey), true)));
}

/** ZONE beats CITY beats DEFAULT; within a level, the latest effectiveFrom wins. */
export function choosePlan(plans: readonly RiderPayPlan[], place: JobPlace, zoneIds: ReadonlySet<string>): RiderPayPlan | null {
  const byLatest = (a: RiderPayPlan, b: RiderPayPlan) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0);
  const pick = (scope: PayPlanScope, match: (p: RiderPayPlan) => boolean) =>
    plans.filter((p) => p.scopeType === scope && match(p)).sort(byLatest)[0] ?? null;
  return (
    pick("ZONE", (p) => p.zoneId != null && zoneIds.has(p.zoneId)) ??
    pick("CITY", (p) => sameCity(p.city, place.city)) ??
    pick("DEFAULT", () => true)
  );
}

export async function resolvePlan(place: JobPlace, at: Date = new Date(), client: DbClient = db): Promise<RiderPayPlan | null> {
  const [plans, zones] = await Promise.all([plansInForce(at, client), activeZones(client)]);
  return choosePlan(plans, place, zonesAt(zones, place.point));
}

/* ------------------------------------------------------------ surges */

const SURGE_LABEL: Record<SurgeReason, string> = { RAIN: "Rain", FESTIVAL: "Festival", EVENT: "Event", OTHER: "Surge" };

/** Manual surges live at `at` for this place (city-wide, the zone it is in, or everywhere). */
export async function liveSurges(place: JobPlace, at: Date = new Date(), client: DbClient = db): Promise<RiderSurge[]> {
  const rows = await client
    .select()
    .from(riderSurges)
    .where(and(lte(riderSurges.startsAt, at), gt(riderSurges.endsAt, at), isNull(riderSurges.endedAt)));
  if (rows.length === 0) return [];
  const zoneIds = zonesAt(await activeZones(client), place.point);
  return rows.filter((s) => (s.zoneId ? zoneIds.has(s.zoneId) : s.city ? sameCity(s.city, place.city) : true));
}

type SlotRow = typeof riderEarningSlots.$inferSelect;

async function activeSlots(client: DbClient): Promise<SlotRow[]> {
  return client.select().from(riderEarningSlots).where(eq(riderEarningSlots.isActive, true));
}

/** The surge sources at `at`: the peak slot (its multiplier and peak bonus) and manual surges. */
export function surgeSources(slots: readonly SlotRow[], surges: readonly RiderSurge[], at: Date, timeZone: string): SurgeSource[] {
  const sources: SurgeSource[] = [];
  const slot = pickSlot(slots as unknown as SlotRule[], at, timeZone) as unknown as SlotRow | null;
  if (slot && ((slot.surgeMultiplierBp ?? 10000) > 10000 || slot.peakBonusPaise > 0)) {
    sources.push({ label: slot.name, multiplierBp: slot.surgeMultiplierBp ?? 10000, flatPaise: slot.peakBonusPaise });
  }
  for (const s of surges) sources.push({ label: s.note?.trim() || SURGE_LABEL[s.reason], multiplierBp: s.multiplierBp, flatPaise: s.flatPaise });
  return sources;
}

/* ------------------------------------------------------------ quotes */

export interface QuoteContext {
  plan: RiderPayPlan;
  quote: PayQuote;
}

/** Everything needed to price many jobs at once (the job board): read once per request. */
export interface QuoteKit {
  at: Date;
  plans: RiderPayPlan[];
  zones: ZoneRow[];
  slots: SlotRow[];
  surges: RiderSurge[];
  timeZone: string;
}

export async function loadQuoteKit(at: Date = new Date(), client: DbClient = db): Promise<QuoteKit> {
  const [plans, zones, slots, surges] = await Promise.all([
    plansInForce(at, client),
    activeZones(client),
    activeSlots(client),
    client.select().from(riderSurges).where(and(lte(riderSurges.startsAt, at), gt(riderSurges.endsAt, at), isNull(riderSurges.endedAt))),
  ]);
  return { at, plans, zones, slots, surges, timeZone: getEnv().APP_TIMEZONE };
}

export function quoteWithKit(
  kit: QuoteKit,
  input: { shop: JobPlace; legKm: number | null; riderPoint: JobPlace["point"]; extraLegsKm?: number[] },
): QuoteContext | null {
  const zoneIds = zonesAt(kit.zones, input.shop.point);
  const plan = choosePlan(kit.plans, input.shop, zoneIds);
  if (!plan) return null;
  const surges = kit.surges.filter((s) => (s.zoneId ? zoneIds.has(s.zoneId) : s.city ? sameCity(s.city, input.shop.city) : true));
  const firstMileKm = input.riderPoint && input.shop.point ? haversineDistanceKm(input.riderPoint, input.shop.point) : 0;
  const quote = computeQuote(
    toTerms(plan),
    {
      legM: Math.round((input.legKm ?? 0) * 1000),
      firstMileM: Math.round(firstMileKm * 1000),
      extraLegsM: (input.extraLegsKm ?? []).map((km) => Math.round(km * 1000)),
    },
    surgeSources(kit.slots, surges, kit.at, kit.timeZone),
  );
  return { plan, quote };
}

/**
 * What a rider would be paid for a job right now. `legKm` is the shop → customer leg stored on
 * the delivery; the first mile is the rider's last known position → the shop (straight line).
 */
export async function quoteJob(
  input: { shop: JobPlace; legKm: number | null; riderPoint: JobPlace["point"]; extraLegsKm?: number[]; at?: Date },
  client: DbClient = db,
): Promise<QuoteContext | null> {
  return quoteWithKit(await loadQuoteKit(input.at ?? new Date(), client), input);
}

/** The quote for one delivery row, as the given rider would see it (not stored). */
export async function quoteDeliveryForRider(
  delivery: Pick<DeliveryOrder, "orderId" | "distanceKm">,
  riderPoint: JobPlace["point"],
  client: DbClient = db,
): Promise<QuoteContext | null> {
  const [row] = await client
    .select({ city: shops.city, latitude: shops.latitude, longitude: shops.longitude })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, delivery.orderId));
  if (!row) return null;
  const legKm = delivery.distanceKm != null ? Number(delivery.distanceKm) : null;
  return quoteJob(
    { shop: { city: row.city, point: parseCoordinates(row.latitude, row.longitude) }, legKm: Number.isFinite(legKm) ? legKm : null, riderPoint },
    client,
  );
}

/**
 * Locks the quote on an accepted delivery (inside the accept transaction). No-op when the rule is
 * off, when a quote is already locked, or when no plan applies — the flat-rate path then pays.
 */
export async function lockQuoteOnAccept(tx: DbClient, deliveryOrderId: string): Promise<PayQuote | null> {
  if (!(await payPlansEnabled())) return null;
  const [delivery] = await tx.select().from(deliveryOrders).where(eq(deliveryOrders.id, deliveryOrderId));
  if (!delivery || delivery.quotePaise != null) return delivery?.quoteBreakdown ?? null;
  const [rider] = await tx
    .select({ lat: deliveryPartners.lastLocationLatitude, lng: deliveryPartners.lastLocationLongitude })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.id, delivery.deliveryPartnerId));
  const ctx = await quoteDeliveryForRider(delivery, parseCoordinates(rider?.lat ?? null, rider?.lng ?? null), tx);
  if (!ctx) return null;
  const now = new Date();
  await tx
    .update(deliveryOrders)
    .set({ quotePaise: ctx.quote.quotePaise, quoteBreakdown: ctx.quote, payPlanId: ctx.plan.id, quotedAt: now, updatedAt: now })
    .where(and(eq(deliveryOrders.id, deliveryOrderId), isNull(deliveryOrders.quotePaise)));
  return ctx.quote;
}

/* ------------------------------------------------------------ admin: plans */

export interface PlanInput {
  name: string;
  scopeType: PayPlanScope;
  city?: string | null;
  zoneId?: string | null;
  baseFeePaise: number;
  baseIncludedM: number;
  slabs: PaySlab[];
  freeFirstMileM: number;
  firstMileRatePaise: number;
  firstMileCapPaise: number;
  freeWaitMin: number;
  waitRatePaise: number;
  waitCapPaise: number;
  extraDropFeePaise: number;
  longDistanceM: number | null;
  longDistanceBonusPaise: number;
  minGuaranteePaise: number;
  maxPerOrderPaise: number | null;
  rerouteTolerancePct: number;
  note?: string | null;
}

async function checkInput(input: PlanInput): Promise<void> {
  if (!input.name.trim()) throw validationFailed("Give the plan a name.");
  if (input.scopeType === "CITY" && !input.city?.trim()) throw validationFailed("Choose the city this plan is for.");
  if (input.scopeType === "ZONE") {
    if (!input.zoneId) throw validationFailed("Choose the zone this plan is for.");
    const zone = await db.query.deliveryZones.findFirst({ where: eq(deliveryZones.id, input.zoneId) });
    if (!zone) throw validationFailed("That zone does not exist.");
  }
  const problems = planProblems({ ...input, id: null, version: null });
  if (problems.length) throw validationFailed(problems.join(" "), { problems });
}

const planValues = (input: PlanInput) => ({
  name: input.name.trim(),
  scopeType: input.scopeType,
  city: input.scopeType === "DEFAULT" ? null : input.city?.trim() || null,
  zoneId: input.scopeType === "ZONE" ? input.zoneId ?? null : null,
  baseFeePaise: input.baseFeePaise,
  baseIncludedM: input.baseIncludedM,
  slabs: input.slabs,
  freeFirstMileM: input.freeFirstMileM,
  firstMileRatePaise: input.firstMileRatePaise,
  firstMileCapPaise: input.firstMileCapPaise,
  freeWaitMin: input.freeWaitMin,
  waitRatePaise: input.waitRatePaise,
  waitCapPaise: input.waitCapPaise,
  extraDropFeePaise: input.extraDropFeePaise,
  longDistanceM: input.longDistanceM,
  longDistanceBonusPaise: input.longDistanceBonusPaise,
  minGuaranteePaise: input.minGuaranteePaise,
  maxPerOrderPaise: input.maxPerOrderPaise,
  rerouteTolerancePct: input.rerouteTolerancePct,
  note: input.note?.trim() || null,
});

export interface PlanView extends RiderPayPlan {
  words: string[];
  label: string;
  /** True while this version is the one pricing new offers in its scope. */
  inForce: boolean;
}

export async function listPlans(): Promise<PlanView[]> {
  await promoteDuePlans();
  const rows = await db.select().from(riderPayPlans).orderBy(riderPayPlans.scopeType, riderPayPlans.name, desc(riderPayPlans.version));
  const inForce = new Set((await plansInForce(new Date(), db)).map((p) => p.id));
  return rows.map((r) => ({ ...r, words: describePlan(toTerms(r)), label: planLabel(r), inForce: inForce.has(r.id) }));
}

export async function getPlan(id: string): Promise<RiderPayPlan> {
  const plan = await db.query.riderPayPlans.findFirst({ where: eq(riderPayPlans.id, id) });
  if (!plan) throw notFound("Pay plan");
  return plan;
}

/** A new plan (its version 1 draft). */
export async function createPlan(input: PlanInput, actor: Actor): Promise<RiderPayPlan> {
  await checkInput(input);
  const [saved] = await db
    .insert(riderPayPlans)
    .values({ ...planValues(input), planKey: crypto.randomUUID(), version: 1, status: "DRAFT", createdBy: actor.id })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_PAY_PLAN_SAVED,
    entityType: "rider_pay_plan",
    entityId: saved.id,
    newValue: saved,
  });
  return saved;
}

/** Edits a draft. Published versions are read-only — clone them instead. Clears the simulator run. */
export async function updateDraft(id: string, input: PlanInput, actor: Actor): Promise<RiderPayPlan> {
  const previous = await getPlan(id);
  if (previous.status !== "DRAFT") throw conflict("A published version cannot be changed. Make a new version from it.");
  await checkInput(input);
  const [saved] = await db
    .update(riderPayPlans)
    .set({ ...planValues(input), simulation: null, simulatedAt: null, updatedAt: new Date() })
    .where(and(eq(riderPayPlans.id, id), eq(riderPayPlans.status, "DRAFT")))
    .returning();
  if (!saved) throw conflict("This draft was published meanwhile. Reload the page.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_PAY_PLAN_SAVED,
    entityType: "rider_pay_plan",
    entityId: saved.id,
    previousValue: previous,
    newValue: saved,
  });
  return saved;
}

/** A new DRAFT version of the same plan from any version (or, with asNewPlan, a separate plan to re-scope). */
export async function clonePlan(id: string, actor: Actor, asNewPlan = false): Promise<RiderPayPlan> {
  const source = await getPlan(id);
  const existingDraft = asNewPlan
    ? null
    : await db.query.riderPayPlans.findFirst({ where: and(eq(riderPayPlans.planKey, source.planKey), eq(riderPayPlans.status, "DRAFT")) });
  if (existingDraft) throw conflict(`There is already a draft of this plan (version ${existingDraft.version}). Edit that one.`);
  const [{ maxVersion }] = await db
    .select({ maxVersion: sql<number>`coalesce(max(${riderPayPlans.version}), 0)::int` })
    .from(riderPayPlans)
    .where(eq(riderPayPlans.planKey, source.planKey));
  const {
    id: _id,
    planKey,
    version: _v,
    status: _s,
    effectiveFrom: _e,
    simulation: _sim,
    simulatedAt: _sa,
    publishedAt: _pa,
    publishedBy: _pb,
    retiredAt: _r,
    createdAt: _c,
    updatedAt: _u,
    createdBy: _cb,
    ...terms
  } = source;
  void [_id, _v, _s, _e, _sim, _sa, _pa, _pb, _r, _c, _u, _cb];
  const [saved] = await db
    .insert(riderPayPlans)
    .values({
      ...terms,
      name: asNewPlan ? `${source.name} (copy)` : source.name,
      planKey: asNewPlan ? crypto.randomUUID() : planKey,
      version: asNewPlan ? 1 : maxVersion + 1,
      status: "DRAFT",
      note: null,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_PAY_PLAN_SAVED,
    entityType: "rider_pay_plan",
    entityId: saved.id,
    newValue: { clonedFrom: source.id, version: saved.version },
  });
  return saved;
}

/* ------------------------------------------------------------ simulator */

export interface SimulationResult {
  days: number;
  from: string;
  to: string;
  orders: number;
  draftTotalPaise: number;
  currentTotalPaise: number;
  draftAvgPaise: number;
  currentAvgPaise: number;
  changePaise: number;
  changePct: number | null;
  /** Orders the draft would apply to (its scope) — others keep their own plan. */
  inScope: number;
  byArea: { area: string; orders: number; draftTotalPaise: number; currentTotalPaise: number; changePct: number | null }[];
  ranAt: string;
}

const pct = (draft: number, current: number) => (current > 0 ? Math.round(((draft - current) / current) * 1000) / 10 : null);

/**
 * Replays the delivered orders of the last `days` days under the draft: what the trip part of the
 * pay would have been, against what was actually paid (base + distance + slot + minimum, without
 * incentives, which the plan does not change). Only orders in the draft's scope are counted.
 */
export async function simulatePlan(id: string, days: 7 | 30, actor: Actor): Promise<SimulationResult> {
  const plan = await getPlan(id);
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const rows = await db
    .select({
      deliveredAt: deliveryOrders.deliveredAt,
      distanceKm: deliveryOrders.distanceKm,
      quote: deliveryOrders.quoteBreakdown,
      city: shops.city,
      shopLat: shops.latitude,
      shopLng: shops.longitude,
      base: deliveryPartnerEarnings.basePaise,
      distance: deliveryPartnerEarnings.distancePaise,
      orderComponent: deliveryPartnerEarnings.orderComponentPaise,
      slotIncentive: deliveryPartnerEarnings.slotIncentivePaise,
      minTopUp: deliveryPartnerEarnings.minTopUpPaise,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .innerJoin(deliveryPartnerEarnings, eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrders.id))
    .where(and(eq(deliveryOrders.status, "DELIVERED"), gte(deliveryOrders.deliveredAt, from), lte(deliveryOrders.deliveredAt, now)))
    .limit(20_000);

  const [zones, slots, surges] = await Promise.all([
    activeZones(db),
    activeSlots(db),
    db.select().from(riderSurges).where(gt(riderSurges.endsAt, from)),
  ]);
  const tz = getEnv().APP_TIMEZONE;
  const terms = toTerms(plan);
  const areas = new Map<string, { orders: number; draft: number; current: number }>();
  let draftTotal = 0;
  let currentTotal = 0;
  let count = 0;
  for (const r of rows) {
    const point = parseCoordinates(r.shopLat, r.shopLng);
    const zoneIds = zonesAt(zones, point);
    const inScope =
      plan.scopeType === "DEFAULT" ||
      (plan.scopeType === "CITY" && sameCity(plan.city, r.city)) ||
      (plan.scopeType === "ZONE" && plan.zoneId != null && zoneIds.has(plan.zoneId));
    if (!inScope || !r.deliveredAt) continue;
    const at = r.deliveredAt;
    const live = surges.filter(
      (s) =>
        s.startsAt <= at &&
        s.endsAt > at &&
        (!s.endedAt || s.endedAt > at) &&
        (s.zoneId ? zoneIds.has(s.zoneId) : s.city ? sameCity(s.city, r.city) : true),
    );
    const legKm = r.distanceKm != null ? Number(r.distanceKm) : 0;
    const quote = computeQuote(
      terms,
      { legM: Math.round((Number.isFinite(legKm) ? legKm : 0) * 1000), firstMileM: r.quote?.firstMileM ?? 0 },
      surgeSources(slots, live, at, tz),
    );
    const current = r.base + r.distance + r.orderComponent + r.slotIncentive + r.minTopUp;
    draftTotal += quote.quotePaise;
    currentTotal += current;
    count += 1;
    const area = r.city || "—";
    const a = areas.get(area) ?? { orders: 0, draft: 0, current: 0 };
    a.orders += 1;
    a.draft += quote.quotePaise;
    a.current += current;
    areas.set(area, a);
  }

  const result: SimulationResult = {
    days,
    from: localTime(from, tz).dateKey,
    to: localTime(now, tz).dateKey,
    orders: rows.length,
    inScope: count,
    draftTotalPaise: draftTotal,
    currentTotalPaise: currentTotal,
    draftAvgPaise: count ? Math.round(draftTotal / count) : 0,
    currentAvgPaise: count ? Math.round(currentTotal / count) : 0,
    changePaise: draftTotal - currentTotal,
    changePct: pct(draftTotal, currentTotal),
    byArea: [...areas.entries()]
      .map(([area, a]) => ({ area, orders: a.orders, draftTotalPaise: a.draft, currentTotalPaise: a.current, changePct: pct(a.draft, a.current) }))
      .sort((x, y) => y.orders - x.orders),
    ranAt: now.toISOString(),
  };

  if (plan.status === "DRAFT") {
    await db
      .update(riderPayPlans)
      .set({ simulation: result as unknown as Record<string, unknown>, simulatedAt: now })
      .where(and(eq(riderPayPlans.id, id), eq(riderPayPlans.status, "DRAFT")));
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_PAY_PLAN_SIMULATED,
    entityType: "rider_pay_plan",
    entityId: id,
    newValue: { days, orders: count, changePct: result.changePct },
  });
  return result;
}

/* ------------------------------------------------------------ publish */

/**
 * Publishes a draft: needs a simulator run on the draft as it is now, and a note. From
 * `effectiveFrom` (default: now) it prices NEW offers; quotes already locked and earnings already
 * written keep their amounts. The version it replaces is retired (read-only) at that moment.
 */
export async function publishPlan(id: string, input: { note: string; effectiveFrom?: Date | null }, actor: Actor): Promise<RiderPayPlan> {
  const plan = await getPlan(id);
  if (plan.status !== "DRAFT") throw conflict("Only a draft can be published.");
  if (!plan.simulatedAt || plan.simulatedAt < plan.updatedAt) throw conflict("Run the simulator on this draft before publishing.");
  const note = input.note.trim();
  if (note.length < 5) throw validationFailed("Write a short note saying why the pay is changing.");
  const now = new Date();
  const effectiveFrom = input.effectiveFrom && input.effectiveFrom > now ? input.effectiveFrom : now;
  const scheduled = effectiveFrom > now;

  // Only one version per scope may be in force: another plan with the same scope would compete.
  const sameScope = await db
    .select()
    .from(riderPayPlans)
    .where(and(inArray(riderPayPlans.status, ["ACTIVE", "SCHEDULED"]), eq(riderPayPlans.scopeType, plan.scopeType)));
  const clash = sameScope.find(
    (p) =>
      p.planKey !== plan.planKey &&
      (plan.scopeType === "DEFAULT" ||
        (plan.scopeType === "CITY" && sameCity(p.city, plan.city)) ||
        (plan.scopeType === "ZONE" && p.zoneId === plan.zoneId)),
  );
  if (clash) throw conflict(`"${planLabel(clash)}" already covers this ${plan.scopeType.toLowerCase()}. Make a new version of that plan instead.`);

  const previous = sameScope.find((p) => p.planKey === plan.planKey && p.status === "ACTIVE") ?? null;
  const published = await db.transaction(async (tx) => {
    if (!scheduled) {
      await tx
        .update(riderPayPlans)
        .set({ status: "RETIRED", retiredAt: now, updatedAt: now })
        .where(and(eq(riderPayPlans.planKey, plan.planKey), inArray(riderPayPlans.status, ["ACTIVE", "SCHEDULED"])));
    } else {
      // A newer schedule replaces an older one that has not started yet.
      await tx
        .update(riderPayPlans)
        .set({ status: "RETIRED", retiredAt: now, updatedAt: now })
        .where(and(eq(riderPayPlans.planKey, plan.planKey), eq(riderPayPlans.status, "SCHEDULED")));
    }
    const [row] = await tx
      .update(riderPayPlans)
      .set({ status: scheduled ? "SCHEDULED" : "ACTIVE", effectiveFrom, note, publishedAt: now, publishedBy: actor.id, updatedAt: plan.updatedAt })
      .where(and(eq(riderPayPlans.id, id), eq(riderPayPlans.status, "DRAFT")))
      .returning();
    if (!row) throw conflict("This draft was changed meanwhile. Reload the page.");
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_PAY_PLAN_PUBLISHED,
        entityType: "rider_pay_plan",
        entityId: row.id,
        previousValue: previous ? { id: previous.id, label: planLabel(previous), terms: toTerms(previous) } : null,
        newValue: { id: row.id, label: planLabel(row), terms: toTerms(row), effectiveFrom, note, simulation: plan.simulation },
      },
      tx,
    );
    return row;
  });
  return published;
}

/* ------------------------------------------------------------ surges (admin) */

export interface SurgeInput {
  city?: string | null;
  zoneId?: string | null;
  multiplierBp: number;
  flatPaise: number;
  reason: SurgeReason;
  note?: string | null;
  startsAt?: Date | null;
  endsAt: Date;
}

export async function listSurges(limit = 50): Promise<(RiderSurge & { live: boolean })[]> {
  const now = new Date();
  const rows = await db.select().from(riderSurges).orderBy(desc(riderSurges.createdAt)).limit(limit);
  return rows.map((s) => ({ ...s, live: !s.endedAt && s.startsAt <= now && s.endsAt > now }));
}

export async function startSurge(input: SurgeInput, actor: Actor): Promise<RiderSurge> {
  const now = new Date();
  const startsAt = input.startsAt && input.startsAt > now ? input.startsAt : now;
  if (!Number.isInteger(input.multiplierBp) || input.multiplierBp < 10000 || input.multiplierBp > 30000) {
    throw validationFailed("The multiplier must be between ×1.0 and ×3.0.");
  }
  if (!Number.isInteger(input.flatPaise) || input.flatPaise < 0) throw validationFailed("The flat add-on must be zero or more.");
  if (input.multiplierBp === 10000 && input.flatPaise === 0) throw validationFailed("Set a multiplier above ×1.0 or a flat add-on.");
  if (!(input.endsAt > startsAt)) throw validationFailed("The end time must be after the start.");
  if (input.endsAt.getTime() - startsAt.getTime() > 3 * 86_400_000) throw validationFailed("A surge can run for at most 3 days.");
  if (input.zoneId) {
    const zone = await db.query.deliveryZones.findFirst({ where: eq(deliveryZones.id, input.zoneId) });
    if (!zone) throw validationFailed("That zone does not exist.");
  }
  const [saved] = await db
    .insert(riderSurges)
    .values({
      city: input.zoneId ? null : input.city?.trim() || null,
      zoneId: input.zoneId ?? null,
      multiplierBp: input.multiplierBp,
      flatPaise: input.flatPaise,
      reason: input.reason,
      note: input.note?.trim() || null,
      startsAt,
      endsAt: input.endsAt,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_SURGE_STARTED,
    entityType: "rider_surge",
    entityId: saved.id,
    newValue: saved,
  });
  return saved;
}

export async function endSurge(id: string, actor: Actor): Promise<RiderSurge> {
  const now = new Date();
  const [ended] = await db
    .update(riderSurges)
    .set({ endedAt: now, endedBy: actor.id })
    .where(and(eq(riderSurges.id, id), isNull(riderSurges.endedAt)))
    .returning();
  if (!ended) throw conflict("This surge has already ended.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_SURGE_ENDED,
    entityType: "rider_surge",
    entityId: id,
    newValue: { endedAt: now },
  });
  return ended;
}

/* ------------------------------------------------------------ calculator */

export interface CalculatorInput {
  planId?: string | null;
  city?: string | null;
  zoneId?: string | null;
  legKm: number;
  firstMileKm: number;
  waitMin: number;
  extraLegsKm?: number[];
  at?: Date | null;
}

/** Exactly what the rider would see for these numbers: plan, surge, quote, wait pay. */
export async function calculate(input: CalculatorInput) {
  const at = input.at ?? new Date();
  let point: JobPlace["point"] = null;
  if (input.zoneId) {
    const zone = await db.query.deliveryZones.findFirst({ where: eq(deliveryZones.id, input.zoneId) });
    if (zone) point = { latitude: Number(zone.centerLat), longitude: Number(zone.centerLng) };
  }
  const place: JobPlace = { city: input.city ?? null, point };
  const plan = input.planId ? await getPlan(input.planId) : await resolvePlan(place, at);
  if (!plan) throw notFound("Pay plan");
  const [slots, surges] = await Promise.all([activeSlots(db), liveSurges(place, at)]);
  const sources = surgeSources(slots, surges, at, getEnv().APP_TIMEZONE);
  const terms = toTerms(plan);
  const quote = computeQuote(
    terms,
    {
      legM: Math.round(input.legKm * 1000),
      firstMileM: Math.round(input.firstMileKm * 1000),
      extraLegsM: (input.extraLegsKm ?? []).map((k) => Math.round(k * 1000)),
    },
    sources,
  );
  const { computeWaitPay } = await import("@/lib/rider-pay-plan");
  const waitPaise = computeWaitPay(terms, input.waitMin);
  return { plan: { id: plan.id, label: planLabel(plan), status: plan.status }, surges: sources, quote, waitPaise, totalPaise: quote.quotePaise + waitPaise };
}

/* ------------------------------------------------------------ cost view (admin only) */

export interface OrderCostView {
  orderId: string;
  orderNumber: string;
  customerDeliveryFeePaise: number;
  shopDeliveryChargePaise: number;
  riderPayoutPaise: number | null;
  riderQuotePaise: number | null;
  marginPaise: number | null;
}

/** Per-order delivery economics. Admin only — never part of any rider response. */
export async function orderCostView(limit = 50): Promise<OrderCostView[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      deliveryFee: orders.deliveryFeePaise,
      shopCharge: orderFinancials.shopDeliveryChargePaise,
      rider: deliveryPartnerEarnings.totalPaise,
      quote: deliveryOrders.quotePaise,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .leftJoin(orderFinancials, eq(orderFinancials.orderId, orders.id))
    .leftJoin(deliveryPartnerEarnings, eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrders.id))
    .where(eq(deliveryOrders.status, "DELIVERED"))
    .orderBy(desc(deliveryOrders.deliveredAt))
    .limit(limit);
  return rows.map((r) => {
    const income = r.deliveryFee + (r.shopCharge ?? 0);
    return {
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerDeliveryFeePaise: r.deliveryFee,
      shopDeliveryChargePaise: r.shopCharge ?? 0,
      riderPayoutPaise: r.rider,
      riderQuotePaise: r.quote,
      marginPaise: r.rider != null ? income - r.rider : null,
    };
  });
}

/** Zones for the admin pickers. */
export async function listZonesForPicker() {
  return db
    .select({ id: deliveryZones.id, name: deliveryZones.name, city: deliveryZones.city, code: deliveryZones.code })
    .from(deliveryZones)
    .orderBy(deliveryZones.city, deliveryZones.name);
}
