/**
 * Franchise (Model B) recurring commission (owner's final brief 21-Nov-2026 08.06 IST, §4, §6, §8).
 *
 * One-time commission is not here: it is the team plan (src/server/dealers/tiered.ts, cases B1–B4), paid by GoKesari
 * to each person directly. This module works out, per franchise (allocation) and month:
 *   - which shops are attached to it: the shops of the owner's own team in his zone (franchise_shop_attributions —
 *     his, through the franchise's tail), and every other shop in the zone while the franchise is active (free
 *     teams' shops, §6), split 50/50 when the zone has two active franchises (or to the nearest owner);
 *   - the opening shops (attached at the month's start, frozen at the first run), new shops, baseline, points,
 *     bonus and rate (src/lib/franchise-bonus.ts);
 *   - recurring = rate × GoKesari's 2% × delivered order value (net of refunds) × the franchise's share, per shop.
 * Entries go to the existing dealer ledger with the owner as payee when the month is locked on the 5th, so the
 * existing monthly close, payout batch, TDS and statements carry them. Nothing is updated in place.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { distanceM, istMonth, istMonthBounds, type LatLng } from "@/lib/franchise";
import { monthlyBonus, type MonthResult } from "@/lib/franchise-bonus";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  franchiseAllocations,
  franchiseAreas,
  franchiseCodes,
  franchiseMonthlySnapshots,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  referralCodes,
  type FranchiseAllocation,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { bonusSettingsOf, franchiseConfig, franchiseConfigAt, franchiseNow, type FranchiseConfig } from "./config";

interface Actor {
  id: string;
  role: UserRole;
}

/* ============================================================= attributions (owner's team shops) */

/** Admin decision on a held / disputed team-shop attachment: release (earns from now) or reverse (never earns). */
export async function decideAttribution(shopId: string, decision: "RELEASE" | "REVERSE", reason: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN") throw new Error("Only an admin can decide an attribution.");
  if (reason.trim().length < 5) throw new Error("Give a reason of at least 5 characters.");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId)).for("update");
    if (!before) throw new Error("No franchise attribution for this shop.");
    const status = decision === "RELEASE" ? "ACTIVE" : "REVERSED";
    await tx.update(franchiseShopAttributions).set({ status, holdReason: decision === "RELEASE" ? null : reason, updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: { status: before.status, holdReason: before.holdReason }, after: { status }, reason, changedBy: actor.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, previousValue: { status: before.status }, newValue: { status, reason } }, tx);
  });
}

/** When the dealer ledger reverses a shop (refund etc.), its franchise attachment is marked REVERSED too. */
export async function markFranchiseShopReversed(shopId: string, reason: string, client: DbClient = db): Promise<void> {
  const [before] = await client.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (!before || before.status === "REVERSED") return;
  await client.update(franchiseShopAttributions).set({ status: "REVERSED", holdReason: reason.slice(0, 300), updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
  await client.insert(franchiseShopAttributionHistory).values({ shopId, before: { status: before.status }, after: { status: "REVERSED" }, reason: reason.slice(0, 300) });
}

/** The franchise owner a shop's team belongs to (any status but REVERSED), or null. */
export async function franchiseOwnerOf(client: DbClient, shopId: string): Promise<string | null> {
  const [r] = await client.select({ owner: franchiseShopAttributions.ownerDealerId, status: franchiseShopAttributions.status }).from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  return r && r.status !== "REVERSED" ? r.owner : null;
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/* ============================================================= who earns on a shop at a moment (§6, §4.2) */

const ENDED = new Set(["TERMINATED", "CANCELLED"]);
/** When the franchise stops being active: termination / cancellation, else its expiry. */
const activeEnd = (a: FranchiseAllocation) => (ENDED.has(a.status) ? a.endedAt : a.expiresAt);
const isActiveAt = (a: FranchiseAllocation, t: number) => a.status !== "CANCELLED" && !!a.activatedAt && a.activatedAt.getTime() <= t && (activeEnd(a)?.getTime() ?? 0) > t;
/** The tail (§4.2): after a lapse, own-team shops keep earning until tailEndAt (terminated / voided: none). */
const inTailAt = (a: FranchiseAllocation, t: number) => !ENDED.has(a.status) && !!a.expiresAt && !!a.tailEndAt && a.expiresAt.getTime() <= t && a.tailEndAt.getTime() > t;

interface ZoneContext {
  zoneId: string;
  allocations: FranchiseAllocation[];
  /** Own-team shops → their franchise (ACTIVE attributions only). */
  team: Map<string, { allocationId: string; ownerDealerId: string }>;
  /** Shop and owner points for the "nearest owner" split. */
  shopPoint: Map<string, LatLng>;
  ownerPoint: Map<string, LatLng>;
  splitMode: FranchiseConfig["recurringSplitMode"];
}

async function zoneContext(client: DbClient, zoneId: string, splitMode: FranchiseConfig["recurringSplitMode"]): Promise<ZoneContext> {
  const allocations = (await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.zoneId, zoneId))).filter((a) => !!a.activatedAt && a.status !== "CANCELLED");
  const team = new Map(
    (await client.select().from(franchiseShopAttributions).where(and(eq(franchiseShopAttributions.zoneId, zoneId), eq(franchiseShopAttributions.status, "ACTIVE")))).map((r) => [r.shopId, { allocationId: r.allocationId, ownerDealerId: r.ownerDealerId }]),
  );
  const shopPoint = new Map<string, LatLng>();
  const ownerPoint = new Map<string, LatLng>();
  if (splitMode === "nearest") {
    const pts = (await client.execute(sql`
      select p.shop_id, a.lat, a.lng from franchise_shop_area_periods p join franchise_areas a on a.id = p.area_id
      where p.zone_id = ${zoneId} and p.valid_to is null and a.lat is not null`)) as unknown as { shop_id: string; lat: string; lng: string }[];
    for (const p of pts) shopPoint.set(p.shop_id, [Number(p.lat), Number(p.lng)]);
    const owners = [...new Set(allocations.map((a) => a.ownerDealerId))];
    if (owners.length) {
      const rows = await client.select({ id: dealers.id, pincode: dealers.pincode }).from(dealers).where(inArray(dealers.id, owners));
      const areas = await client.select({ pincodes: franchiseAreas.pincodes, lat: franchiseAreas.lat, lng: franchiseAreas.lng }).from(franchiseAreas);
      for (const r of rows) {
        const a = r.pincode ? areas.find((x) => x.pincodes.includes(r.pincode!) && x.lat != null) : null;
        if (a) ownerPoint.set(r.id, [Number(a.lat), Number(a.lng)]);
      }
    }
  }
  return { zoneId, allocations, team, shopPoint, ownerPoint, splitMode };
}

/** The franchises earning on `shopId` at `t` and their shares (summing to 1, or nothing). */
export function earnersAt(ctx: ZoneContext, shopId: string, t: number): { allocationId: string; share: number }[] {
  const own = ctx.team.get(shopId);
  if (own) {
    const a = ctx.allocations.find((x) => x.id === own.allocationId);
    if (a && (isActiveAt(a, t) || inTailAt(a, t))) return [{ allocationId: a.id, share: 1 }];
  }
  const active = ctx.allocations.filter((a) => isActiveAt(a, t));
  if (!active.length) return [];
  if (active.length > 1 && ctx.splitMode === "nearest") {
    const p = ctx.shopPoint.get(shopId);
    const ranked = p ? active.map((a) => ({ a, d: ctx.ownerPoint.get(a.ownerDealerId) ? distanceM(p, ctx.ownerPoint.get(a.ownerDealerId)!) : null })).filter((x) => x.d != null) : [];
    if (ranked.length === active.length) {
      ranked.sort((x, y) => x.d! - y.d! || x.a.slotNo - y.a.slotNo);
      return [{ allocationId: ranked[0].a.id, share: 1 }];
    }
  }
  return active.map((a) => ({ allocationId: a.id, share: 1 / active.length }));
}

const shareOf = (earners: { allocationId: string; share: number }[], allocationId: string) => earners.find((e) => e.allocationId === allocationId)?.share ?? 0;

/* ============================================================= the month of one franchise */

interface ShopLine {
  shopId: string;
  /** Delivered order value in the month × this franchise's share, net of refunds on the month's orders. */
  netPaise: number;
  /** The same, unweighted (business points use the shop's whole business). */
  fullPaise: number;
  opening: boolean;
  /** Refunds recorded this month on orders of earlier months (already paid on): taken back. */
  adjustmentPaise: number;
}

export interface SnapshotCalc {
  allocation: FranchiseAllocation;
  code: string | null;
  month: string;
  configVersion: number;
  openingShopIds: string[];
  newShopIds: string[];
  result: MonthResult;
  bonusEligible: boolean;
  lines: (ShopLine & { basePaise: number; bonusPaise: number })[];
  nextOpeningShops: number;
}

/**
 * Works out one franchise's month (no writes). Opening shops come from an existing DRAFT snapshot when there is one
 * (frozen at the first run), otherwise: approved shops attached to the franchise at the month's start (§4.1: the
 * attached shops at the end of the previous month; shops registered this month are excluded). New shops: approved
 * during the month and attached to the franchise then.
 */
export async function calculateAllocationMonth(client: DbClient, allocation: FranchiseAllocation, month: string, frozenOpening: string[] | null = null): Promise<SnapshotCalc> {
  const { start, end } = istMonthBounds(month);
  const versioned = await franchiseConfigAt(start, client); // the settings in force when the month began
  const settings = bonusSettingsOf(versioned.config);
  const ctx = await zoneContext(client, allocation.zoneId, versioned.config.recurringSplitMode);
  const s = start.toISOString();
  const e = end.toISOString();

  // Every shop that was in the zone at some point of the month, with its approval.
  const shops = (await client.execute(sql`
    select distinct sh.id, sh.status, sh.approved_at,
      (select p2.zone_id from franchise_shop_area_periods p2 where p2.shop_id = sh.id and p2.valid_from <= ${s}::timestamptz and (p2.valid_to is null or p2.valid_to > ${s}::timestamptz) order by p2.valid_from desc limit 1) as zone_at_start,
      (select p3.zone_id from franchise_shop_area_periods p3 where p3.shop_id = sh.id and p3.valid_from <= coalesce(sh.approved_at, ${s}::timestamptz) and (p3.valid_to is null or p3.valid_to > coalesce(sh.approved_at, ${s}::timestamptz)) order by p3.valid_from desc limit 1) as zone_at_approval
    from franchise_shop_area_periods p join shops sh on sh.id = p.shop_id
    where p.zone_id = ${allocation.zoneId} and p.valid_from < ${e}::timestamptz and (p.valid_to is null or p.valid_to > ${s}::timestamptz)`)) as unknown as { id: string; status: string; approved_at: string | Date | null; zone_at_start: string | null; zone_at_approval: string | null }[];
  const approvedAt = (r: (typeof shops)[number]) => (r.approved_at ? new Date(r.approved_at).getTime() : null);
  const openingShopIds =
    frozenOpening ??
    shops
      .filter((r) => r.status === "APPROVED" && approvedAt(r) != null && approvedAt(r)! < start.getTime() && r.zone_at_start === allocation.zoneId && shareOf(earnersAt(ctx, r.id, start.getTime()), allocation.id) > 0)
      .map((r) => r.id)
      .sort();
  const newShopIds = shops
    .filter((r) => r.status === "APPROVED" && approvedAt(r) != null && approvedAt(r)! >= start.getTime() && approvedAt(r)! < end.getTime() && r.zone_at_approval === allocation.zoneId && shareOf(earnersAt(ctx, r.id, approvedAt(r)!), allocation.id) > 0)
    .map((r) => r.id)
    .sort();

  const lines = new Map<string, ShopLine>();
  const opening = new Set(openingShopIds);
  const line = (shopId: string) => {
    let l = lines.get(shopId);
    if (!l) lines.set(shopId, (l = { shopId, netPaise: 0, fullPaise: 0, opening: opening.has(shopId), adjustmentPaise: 0 }));
    return l;
  };
  // Orders delivered this month while the shop was in this zone.
  const delivered = (await client.execute(sql`
    select o.shop_id, o.goods_paise as goods, o.delivered_at
    from order_financials o
    join franchise_shop_area_periods p on p.shop_id = o.shop_id and p.zone_id = ${allocation.zoneId}
      and o.delivered_at >= p.valid_from and (p.valid_to is null or o.delivered_at < p.valid_to)
    where o.delivered_at >= ${s}::timestamptz and o.delivered_at < ${e}::timestamptz`)) as unknown as { shop_id: string; goods: string | number; delivered_at: string | Date }[];
  for (const d of delivered) {
    const share = shareOf(earnersAt(ctx, d.shop_id, new Date(d.delivered_at).getTime()), allocation.id);
    if (share <= 0) continue;
    const l = line(d.shop_id);
    l.netPaise += Number(d.goods) * share;
    l.fullPaise += Number(d.goods);
  }
  // Refunds recorded this month on orders delivered in this zone (this month: netted; earlier: taken back).
  const refunds = (await client.execute(sql`
    select o.shop_id, o.goods_paise as goods, adj.customer_refund_paise as refund, o.delivered_at
    from financial_adjustments adj
    join order_financials o on o.order_id = adj.order_id
    join franchise_shop_area_periods p on p.shop_id = o.shop_id and p.zone_id = ${allocation.zoneId}
      and o.delivered_at >= p.valid_from and (p.valid_to is null or o.delivered_at < p.valid_to)
    where adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM') and o.delivered_at is not null
      and adj.created_at >= ${s}::timestamptz and adj.created_at < ${e}::timestamptz`)) as unknown as { shop_id: string; goods: string | number; refund: string | number; delivered_at: string | Date }[];
  const paidRates = new Map((await client.select({ month: franchiseMonthlySnapshots.month, rate: franchiseMonthlySnapshots.commissionRateBp }).from(franchiseMonthlySnapshots).where(and(eq(franchiseMonthlySnapshots.allocationId, allocation.id), eq(franchiseMonthlySnapshots.status, "LOCKED")))).map((r) => [r.month, r.rate]));
  for (const r of refunds) {
    const at = new Date(r.delivered_at);
    const share = shareOf(earnersAt(ctx, r.shop_id, at.getTime()), allocation.id);
    if (share <= 0) continue;
    const refunded = Math.min(Number(r.refund), Number(r.goods));
    if (at.getTime() >= start.getTime()) {
      line(r.shop_id).netPaise -= refunded * share;
      line(r.shop_id).fullPaise -= refunded;
    } else {
      const rate = paidRates.get(istMonth(at)) ?? settings.recurringBaseBp;
      line(r.shop_id).adjustmentPaise -= Math.round((refunded * share * settings.gokesariCommissionBp * rate) / 100_000_000);
    }
  }
  const all = [...lines.values()].map((l) => ({ ...l, netPaise: Math.round(l.netPaise) }));
  const openingBusinessPaise = all.filter((l) => l.opening).reduce((sum, l) => sum + l.fullPaise, 0);
  const allBusinessPaise = all.reduce((sum, l) => sum + l.netPaise, 0);
  // The owner's own one-time commission on this franchise's new shops this month (shown on the statement; it is
  // paid through the team plan's own ledger entries, never again here).
  const [onboarding] = newShopIds.length
    ? await client
        .select({ amount: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::bigint` })
        .from(dealerCommissionLedger)
        .where(and(eq(dealerCommissionLedger.dealerId, allocation.ownerDealerId), sql`${dealerCommissionLedger.payeeMemberId} is null`, eq(dealerCommissionLedger.kind, "ACCRUAL"), inArray(dealerCommissionLedger.entryType, ["DIRECT_1", "DIRECT_2", "OVERRIDE_LEAD", "OVERRIDE_MAIN"]), inArray(dealerCommissionLedger.shopId, newShopIds), sql`${dealerCommissionLedger.status} <> 'REVERSED'`))
    : [{ amount: 0 }];
  // §4.2: an expired / not-renewed / terminated franchise earns no bonus (the base share continues in its tail).
  const bonusEligible = (allocation.status === "ACTIVE" || allocation.status === "SUSPENDED") && !!allocation.expiresAt && allocation.expiresAt.getTime() >= end.getTime() - 1000;
  const result = monthlyBonus(
    { openingShops: openingShopIds.length, newShops: newShopIds.length, openingBusinessPaise, allBusinessPaise, onboardingPaise: Number(onboarding?.amount ?? 0), adjustmentsPaise: all.reduce((sum, l) => sum + l.adjustmentPaise, 0), bonusEligible },
    settings,
  );
  // Per-shop payout lines (the ledger needs a shop on each entry): base share and bonus separately.
  const priced = all.map((l) => ({ ...l, basePaise: Math.round((l.netPaise * settings.gokesariCommissionBp * settings.recurringBaseBp) / 100_000_000), bonusPaise: Math.round((l.netPaise * settings.gokesariCommissionBp * result.bonusBp) / 100_000_000) }));
  const recurring = priced.reduce((sum, l) => sum + l.basePaise + l.bonusPaise, 0);
  result.recurringPaise = recurring;
  result.totalPayoutPaise = recurring + result.onboardingPaise + result.adjustmentsPaise;
  const stillLive = new Set(shops.filter((r) => r.status === "APPROVED").map((r) => r.id));
  const [codeRow] = await client.select({ code: referralCodes.code }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(eq(franchiseCodes.allocationId, allocation.id));
  return {
    allocation,
    code: codeRow?.code ?? null,
    month,
    configVersion: versioned.version,
    openingShopIds,
    newShopIds,
    result,
    bonusEligible,
    lines: priced,
    nextOpeningShops: [...new Set([...openingShopIds, ...newShopIds])].filter((id) => stillLive.has(id)).length,
  };
}

/** Franchises that earn something in `month`: activated before its end and still active or in a tail at its start. */
async function earningAllocations(client: DbClient, month: string): Promise<FranchiseAllocation[]> {
  const { start, end } = istMonthBounds(month);
  const rows = await client.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.isTest, false), sql`${franchiseAllocations.activatedAt} < ${end.toISOString()}::timestamptz`));
  return rows.filter((a) => {
    if (a.status === "CANCELLED") return false;
    const stop = ENDED.has(a.status) ? a.endedAt : (a.tailEndAt ?? a.expiresAt);
    return !stop || stop.getTime() >= start.getTime();
  });
}

const snapshotValues = (c: SnapshotCalc) => ({
  allocationId: c.allocation.id,
  ownerDealerId: c.allocation.ownerDealerId,
  zoneId: c.allocation.zoneId,
  code: c.code,
  month: c.month,
  configVersion: c.configVersion,
  openingShopIds: c.openingShopIds,
  openingShops: c.result.openingShops,
  baselinePaise: c.result.baselinePaise,
  newShops: c.result.newShops,
  actualBusinessPaise: c.result.actualBusinessPaise,
  allBusinessPaise: c.lines.reduce((s, l) => s + l.netPaise, 0),
  regBasePts: c.result.registrationPoints,
  bizBasePts: c.result.businessPoints,
  totalBasePts: c.result.totalPoints,
  mainPts: c.result.mainPoints,
  bonusBp: c.result.bonusBp,
  commissionRateBp: c.result.commissionRateBp,
  rating: c.result.rating,
  bonusEligible: c.bonusEligible,
  onboardingPaise: c.result.onboardingPaise,
  recurringPaise: c.result.recurringPaise,
  adjustmentsPaise: c.result.adjustmentsPaise,
  totalPayoutPaise: c.result.totalPayoutPaise,
  nextOpeningShops: c.nextOpeningShops,
  calculatedAt: new Date(),
});

/**
 * Calculates (or recalculates) every franchise's month and stores the DRAFT snapshots (days 1–3). Idempotent and
 * rerunnable until the month is locked; a LOCKED snapshot is never touched.
 */
export async function calculateFranchiseMonth(month: string, actor: Actor | null = null): Promise<{ calculated: number; locked: number; skipped?: string }> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM.");
  const { config } = await franchiseConfig();
  if (istMonthBounds(month).end.getTime() > franchiseNow(config).getTime()) return { calculated: 0, locked: 0, skipped: `${month} is not over yet` };
  let calculated = 0;
  let locked = 0;
  for (const allocation of await earningAllocations(db, month)) {
    await db.transaction(async (tx) => {
      await tx.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(eq(franchiseAllocations.id, allocation.id)).for("update");
      const [existing] = await tx.select().from(franchiseMonthlySnapshots).where(and(eq(franchiseMonthlySnapshots.allocationId, allocation.id), eq(franchiseMonthlySnapshots.month, month)));
      if (existing?.status === "LOCKED") {
        locked++;
        return;
      }
      const c = await calculateAllocationMonth(tx, allocation, month, existing ? existing.openingShopIds : null);
      if (existing) await tx.update(franchiseMonthlySnapshots).set(snapshotValues(c)).where(eq(franchiseMonthlySnapshots.id, existing.id));
      else await tx.insert(franchiseMonthlySnapshots).values(snapshotValues(c));
      calculated++;
    });
  }
  await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_COMMISSION, entityType: "franchise_month", entityId: month, newValue: { calculated, locked } });
  return { calculated, locked };
}

/**
 * Locks `month` (the 5th): recalculates each DRAFT one last time, writes its per-shop ledger lines (RECURRING_BASE,
 * RECURRING_BONUS, negative adjustments) dated inside the month so the payout close pays them, and marks it LOCKED.
 * Later corrections go to the next month's adjustments. Idempotent.
 */
export async function lockFranchiseMonth(month: string, actor: Actor | null = null): Promise<{ locked: number; entries: number; skipped?: string }> {
  const calc = await calculateFranchiseMonth(month, actor);
  if (calc.skipped) return { locked: 0, entries: 0, skipped: calc.skipped };
  const { end } = istMonthBounds(month);
  const dated = new Date(end.getTime() - 1000);
  let locked = 0;
  let entries = 0;
  const drafts = await db.select().from(franchiseMonthlySnapshots).where(and(eq(franchiseMonthlySnapshots.month, month), eq(franchiseMonthlySnapshots.status, "DRAFT")));
  for (const snap of drafts) {
    await db.transaction(async (tx) => {
      const [s] = await tx.select().from(franchiseMonthlySnapshots).where(eq(franchiseMonthlySnapshots.id, snap.id)).for("update");
      if (!s || s.status !== "DRAFT") return;
      const [allocation] = await tx.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, s.allocationId));
      const c = await calculateAllocationMonth(tx, allocation, month, s.openingShopIds);
      const [owner] = await tx.select({ status: dealers.status }).from(dealers).where(eq(dealers.id, s.ownerDealerId)).for("update");
      const held = owner?.status !== "APPROVED";
      const write = async (shopId: string, entryType: "RECURRING_BASE" | "RECURRING_BONUS", amount: number, key: string, note: string, bonusBp = 0) => {
        if (amount === 0) return;
        const [exists] = await tx.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(eq(dealerCommissionLedger.accrualKey, key));
        if (exists) return;
        await tx.insert(dealerCommissionLedger).values({
          dealerId: s.ownerDealerId,
          shopId,
          milestone: "MONTHLY",
          kind: amount > 0 ? "ACCRUAL" : "ADJUSTMENT",
          entryType,
          level: 1,
          accrualKey: key,
          basePaise: amount,
          bonusBp,
          bonusPaise: entryType === "RECURRING_BONUS" ? amount : 0,
          amountPaise: amount,
          status: held ? "ON_HOLD" : "EARNED",
          heldFromStatus: held ? "EARNED" : null,
          note: `${month} · zone ${s.zoneId} · ${note}`,
          franchiseAllocationId: s.allocationId,
          franchiseZoneId: s.zoneId,
          configVersion: c.configVersion,
          calcRunId: `LOCK:${month}`,
          createdAt: dated,
          createdBy: actor?.id ?? null,
        });
        entries++;
      };
      for (const l of c.lines) {
        const shareNote = l.fullPaise && Math.abs(l.netPaise - l.fullPaise) > 1 ? ` (franchise share ₹${(l.netPaise / 100).toLocaleString("en-IN")} of ₹${(l.fullPaise / 100).toLocaleString("en-IN")})` : "";
        await write(l.shopId, "RECURRING_BASE", l.basePaise, `FRR:${s.allocationId}:${l.shopId}:${month}`, `₹${(l.netPaise / 100).toLocaleString("en-IN")} delivered${shareNote} × 2% × ${c.result.commissionRateBp - c.result.bonusBp} bp`);
        await write(l.shopId, "RECURRING_BONUS", l.bonusPaise, `FRB:${s.allocationId}:${l.shopId}:${month}`, `bonus ${c.result.bonusBp} bp (${c.result.totalPoints} base points)`, c.result.bonusBp);
        await write(l.shopId, "RECURRING_BASE", l.adjustmentPaise, `FRA:${s.allocationId}:${l.shopId}:${month}`, "refund after an earlier payout");
      }
      await tx.update(franchiseMonthlySnapshots).set({ ...snapshotValues(c), status: "LOCKED", lockedAt: new Date(), lockedBy: actor?.id ?? null }).where(eq(franchiseMonthlySnapshots.id, s.id));
      locked++;
    });
  }
  await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_COMMISSION, entityType: "franchise_month", entityId: month, newValue: { locked, entries } });
  return { locked, entries };
}

/** Live month-to-date for the dashboard: the same calculation on the month so far, not stored. */
export async function liveMonth(allocation: FranchiseAllocation, now: Date): Promise<SnapshotCalc> {
  return calculateAllocationMonth(db, allocation, istMonth(now));
}
