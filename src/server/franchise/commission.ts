/**
 * Franchise (Model B) commission (brief §3, §8): one-time 25% of each activated shop's fee (excluding GST) and,
 * every month, 25% (+ a 0–5 point bonus) of GoKesari's actual order commission on the shops attributed to the
 * owner's allocation, while it is active or in its tail. Entries go to the existing dealer ledger
 * (dealer_commission_ledger) with the owner as payee, so the existing monthly close, payout batch, TDS and
 * statements carry them unchanged. Nothing is ever updated in place: corrections are new entries.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { bpOf, istMonth, istMonthBounds } from "@/lib/franchise";
import { monthlyBonus, type MonthResult } from "@/lib/franchise-bonus";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  financialAdjustments,
  franchiseAllocations,
  franchiseCodes,
  franchiseMonthlySnapshots,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  orderFinancials,
  referralCodes,
  shops,
  type DealerCommissionEntry,
  type FranchiseAllocation,
  type UserRole,
} from "@/server/db/schema";
import { feeBasePaise, getCommissionSettings } from "@/server/dealers/commission";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { bonusSettingsOf, franchiseConfig, franchiseConfigAt, franchiseNow } from "./config";

interface Actor {
  id: string;
  role: UserRole;
}


/* ============================================================= one-time (activation) */

/**
 * The one-time franchise commission on an activated shop (brief §3: 25% of the fee excluding GST; D3 all shop
 * types). Idempotent (accrual key FR1:<shop>). A duplicate / branch shop is HELD for an admin review instead.
 */
export async function accrueFranchiseActivation(shopId: string, actor: Actor | null): Promise<DealerCommissionEntry | null> {
  const [attr] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (!attr || attr.status !== "ACTIVE") return null;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.status !== "APPROVED" || shop.feePaymentStatus !== "PAID") return null;
  const fee = feeBasePaise(shop);
  if (fee <= 0) return null;
  const [already] = await db.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(eq(dealerCommissionLedger.accrualKey, `FR1:${shopId}`));
  if (already) return null;

  // Brief §2.5 / §7: a likely duplicate (same GST / PAN / mobile / nearby name) is held for an admin, not paid.
  const dup = await findLikelyDuplicate(shopId);
  const settings = await getCommissionSettings();
  if (dup.kind === "DUPLICATE" || (dup.kind === "BRANCH" && !settings.branchEligible)) {
    await holdAttribution(shopId, `${dup.kind === "DUPLICATE" ? "likely duplicate" : "branch of another shop"} (${dup.reasons.join(", ")}) — admin review`, actor);
    return null;
  }
  const activatedAt = shop.approvedAt ?? new Date();
  const { version, config } = await franchiseConfigAt(activatedAt);
  const [alloc] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, attr.allocationId));
  const bp = alloc && !alloc.launchOffer && config.postLaunchOneTimeBp != null ? config.postLaunchOneTimeBp : config.oneTimeBp;
  const amount = bpOf(fee, bp);
  const entry = await db.transaction(async (tx) => {
    const [owner] = await tx.select().from(dealers).where(eq(dealers.id, attr.ownerDealerId)).for("update");
    if (!owner) return null;
    const rows = await tx
      .insert(dealerCommissionLedger)
      .values({
        dealerId: owner.id,
        salespersonId: attr.memberId,
        shopId,
        milestone: "ACTIVATED",
        kind: "ACCRUAL",
        entryType: "ONE_TIME_FRANCHISE",
        payeeMemberId: null,
        level: 1,
        accrualKey: `FR1:${shopId}`,
        feePaise: fee,
        basePaise: amount,
        amountPaise: amount,
        status: owner.status === "APPROVED" ? "EARNED" : "ON_HOLD",
        heldFromStatus: owner.status === "APPROVED" ? null : "EARNED",
        note: `Franchise one-time ${bp / 100}% of the fee excl. GST — zone ${attr.zoneId}`,
        franchiseAllocationId: attr.allocationId,
        franchiseZoneId: attr.zoneId,
        configVersion: version,
        createdBy: actor?.id ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!rows.length) return null;
    await tx.update(franchiseShopAttributions).set({ activatedAt, updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_COMMISSION, entityType: "shop", entityId: shopId, newValue: { entryType: "ONE_TIME_FRANCHISE", ownerDealerId: owner.id, feePaise: fee, bp, amountPaise: amount, configVersion: version, zoneId: attr.zoneId } }, tx);
    return { entry: rows[0], userId: owner.userId };
  });
  if (!entry) return null;
  if (entry.userId) {
    await notify({ userId: entry.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "Franchise commission earned", message: `${shop.name} is active: ₹${(amount / 100).toLocaleString("en-IN")} one-time commission (paid on the 5th).` }, actionUrl: "/franchise/my", channels: ["PUSH"], dedupeKey: `franchise-fr1:${shopId}` }).catch(() => {});
  }
  return entry.entry;
}

/** Never lets a franchise problem break a shop approval. */
export async function accrueFranchiseActivationSafely(shopId: string, actor: Actor | null): Promise<void> {
  try {
    await accrueFranchiseActivation(shopId, actor);
  } catch (e) {
    console.error("[franchise] one-time commission failed", shopId, e instanceof Error ? e.message : e);
  }
}

async function holdAttribution(shopId: string, reason: string, actor: Actor | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId)).for("update");
    if (!before || before.status !== "ACTIVE") return;
    await tx.update(franchiseShopAttributions).set({ status: "HELD", holdReason: reason, updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: { status: before.status }, after: { status: "HELD", holdReason: reason }, reason, changedBy: actor?.id ?? null });
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, previousValue: { status: before.status }, newValue: { status: "HELD", reason } }, tx);
  });
}

/** Admin decision on a held / disputed attribution (brief §7): release (pays from now) or reverse (never pays). */
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
  if (decision === "RELEASE") {
    // The duplicate check would hold it again: write the one-time entry directly after the admin's release.
    await accrueAfterRelease(shopId, actor);
  }
}

async function accrueAfterRelease(shopId: string, actor: Actor): Promise<void> {
  const [attr] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!attr || !shop || shop.status !== "APPROVED" || shop.feePaymentStatus !== "PAID") return;
  const fee = feeBasePaise(shop);
  const { version, config } = await franchiseConfigAt(shop.approvedAt ?? new Date());
  const amount = bpOf(fee, config.oneTimeBp);
  if (amount <= 0) return;
  await db
    .insert(dealerCommissionLedger)
    .values({ dealerId: attr.ownerDealerId, shopId, milestone: "ACTIVATED", kind: "ACCRUAL", entryType: "ONE_TIME_FRANCHISE", level: 1, accrualKey: `FR1:${shopId}`, feePaise: fee, basePaise: amount, amountPaise: amount, status: "EARNED", note: `Franchise one-time — released by an admin`, franchiseAllocationId: attr.allocationId, franchiseZoneId: attr.zoneId, configVersion: version, createdBy: actor.id })
    .onConflictDoNothing();
}

/** When the dealer ledger reverses a shop (refund etc.), the franchise attribution is marked REVERSED too. */
export async function markFranchiseShopReversed(shopId: string, reason: string, client: DbClient = db): Promise<void> {
  const [before] = await client.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (!before || before.status === "REVERSED") return;
  await client.update(franchiseShopAttributions).set({ status: "REVERSED", holdReason: reason.slice(0, 300), updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
  await client.insert(franchiseShopAttributionHistory).values({ shopId, before: { status: before.status }, after: { status: "REVERSED" }, reason: reason.slice(0, 300) });
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/* ============================================================= monthly bonus and payout (brief 21-Nov §3, §5) */

interface ShopLine {
  shopId: string;
  /** Delivered order value in the month, net of refunds on the month's orders. */
  netPaise: number;
  opening: boolean;
  /** Refunds recorded this month on orders of earlier months (already paid on): taken back (TC5). */
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

/** When the allocation stops earning recurring commission: termination / cancellation, else the tail end, else expiry. */
const earningEnd = (a: FranchiseAllocation) => (a.status === "TERMINATED" || a.status === "CANCELLED" ? a.endedAt : (a.tailEndAt ?? a.expiresAt));

/**
 * Works out one dealer code's month (no writes). Opening shops are taken from an existing DRAFT snapshot when there
 * is one (frozen at the first run), otherwise as the brief defines them: shops tagged to the code, approved and
 * active, activated before the month began. New shops: activated (paid + approved) during the month.
 */
export async function calculateAllocationMonth(client: DbClient, allocation: FranchiseAllocation, month: string, frozenOpening: string[] | null = null): Promise<SnapshotCalc> {
  const { start, end } = istMonthBounds(month);
  const versioned = await franchiseConfigAt(start, client); // the settings in force when the month began (TC6)
  const settings = bonusSettingsOf(versioned.config);
  const tags = await client
    .select({ shopId: franchiseShopAttributions.shopId, activatedAt: franchiseShopAttributions.activatedAt, status: franchiseShopAttributions.status, shopStatus: shops.status })
    .from(franchiseShopAttributions)
    .innerJoin(shops, eq(shops.id, franchiseShopAttributions.shopId))
    .where(eq(franchiseShopAttributions.allocationId, allocation.id));
  const live = (t: (typeof tags)[number]) => t.status === "ACTIVE" && t.shopStatus === "APPROVED";
  const openingShopIds = frozenOpening ?? tags.filter((t) => live(t) && t.activatedAt && t.activatedAt.getTime() < start.getTime()).map((t) => t.shopId).sort();
  const newShopIds = tags.filter((t) => t.status === "ACTIVE" && t.activatedAt && t.activatedAt.getTime() >= start.getTime() && t.activatedAt.getTime() < end.getTime()).map((t) => t.shopId).sort();
  const earningShops = tags.filter((t) => t.status === "ACTIVE").map((t) => t.shopId);
  const stop = earningEnd(allocation);
  const lines = new Map<string, ShopLine>();
  if (earningShops.length && allocation.activatedAt) {
    const window = sql`o.delivered_at >= ${allocation.activatedAt.toISOString()}::timestamptz and (${stop ? stop.toISOString() : null}::timestamptz is null or o.delivered_at <= ${stop ? stop.toISOString() : null}::timestamptz)`;
    const ids = sql.join(earningShops.map((id) => sql`${id}::uuid`), sql`, `);
    const delivered = (await client.execute(sql`
      select o.shop_id, coalesce(sum(o.goods_paise), 0)::bigint as goods
      from ${orderFinancials} o
      where o.shop_id in (${ids}) and o.delivered_at >= ${start.toISOString()}::timestamptz and o.delivered_at < ${end.toISOString()}::timestamptz and ${window}
      group by o.shop_id`)) as unknown as { shop_id: string; goods: string | number }[];
    const refunds = (await client.execute(sql`
      select o.shop_id, o.goods_paise as goods, adj.customer_refund_paise as refund, o.delivered_at
      from ${financialAdjustments} adj join ${orderFinancials} o on o.order_id = adj.order_id
      where o.shop_id in (${ids}) and adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM')
        and adj.created_at >= ${start.toISOString()}::timestamptz and adj.created_at < ${end.toISOString()}::timestamptz and ${window}`)) as unknown as { shop_id: string; goods: string | number; refund: string | number; delivered_at: string | Date }[];
    const opening = new Set(openingShopIds);
    const line = (shopId: string) => {
      let l = lines.get(shopId);
      if (!l) lines.set(shopId, (l = { shopId, netPaise: 0, opening: opening.has(shopId), adjustmentPaise: 0 }));
      return l;
    };
    for (const d of delivered) line(d.shop_id).netPaise += Number(d.goods);
    // The rate earlier months were paid at (their locked snapshots), for refunds recorded after the payout.
    const paidRates = new Map((await client.select({ month: franchiseMonthlySnapshots.month, rate: franchiseMonthlySnapshots.commissionRateBp }).from(franchiseMonthlySnapshots).where(and(eq(franchiseMonthlySnapshots.allocationId, allocation.id), eq(franchiseMonthlySnapshots.status, "LOCKED")))).map((r) => [r.month, r.rate]));
    for (const r of refunds) {
      const refunded = Math.min(Number(r.refund), Number(r.goods));
      const deliveredAt = new Date(r.delivered_at);
      if (deliveredAt.getTime() >= start.getTime()) line(r.shop_id).netPaise -= refunded;
      else {
        const rate = paidRates.get(istMonth(deliveredAt)) ?? settings.recurringBaseBp;
        line(r.shop_id).adjustmentPaise -= Math.round((refunded * settings.gokesariCommissionBp * rate) / 100_000_000);
      }
    }
  }
  const all = [...lines.values()];
  const openingBusinessPaise = all.filter((l) => l.opening).reduce((s, l) => s + l.netPaise, 0);
  const allBusinessPaise = all.reduce((s, l) => s + l.netPaise, 0);
  const onboarding = newShopIds.length
    ? await client
        .select({ amount: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::bigint` })
        .from(dealerCommissionLedger)
        .where(and(eq(dealerCommissionLedger.entryType, "ONE_TIME_FRANCHISE"), eq(dealerCommissionLedger.kind, "ACCRUAL"), inArray(dealerCommissionLedger.shopId, newShopIds), sql`${dealerCommissionLedger.status} <> 'REVERSED'`))
    : [{ amount: 0 }];
  // Brief 21-Nov §6: an expired / not-renewed / terminated franchise earns no bonus (the base share continues in its tail).
  const bonusEligible = (allocation.status === "ACTIVE" || allocation.status === "SUSPENDED") && !!allocation.expiresAt && allocation.expiresAt.getTime() >= end.getTime() - 1000;
  const result = monthlyBonus(
    { openingShops: openingShopIds.length, newShops: newShopIds.length, openingBusinessPaise, allBusinessPaise, onboardingPaise: Number(onboarding[0]?.amount ?? 0), adjustmentsPaise: all.reduce((s, l) => s + l.adjustmentPaise, 0), bonusEligible },
    settings,
  );
  // Per-shop payout lines (the ledger needs a shop on each entry): base share and bonus separately.
  const priced = all.map((l) => ({ ...l, basePaise: Math.round((l.netPaise * settings.gokesariCommissionBp * settings.recurringBaseBp) / 100_000_000), bonusPaise: Math.round((l.netPaise * settings.gokesariCommissionBp * result.bonusBp) / 100_000_000) }));
  const recurring = priced.reduce((s, l) => s + l.basePaise + l.bonusPaise, 0);
  result.recurringPaise = recurring;
  result.totalPayoutPaise = recurring + result.onboardingPaise + result.adjustmentsPaise;
  const stillLive = new Set(tags.filter(live).map((t) => t.shopId));
  const [codeRow] = await client.select({ code: referralCodes.code }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(and(eq(franchiseCodes.allocationId, allocation.id), isNull(franchiseCodes.memberId)));
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

/** Allocations that earn something in `month`: activated before its end and still earning at its start. */
async function earningAllocations(client: DbClient, month: string): Promise<FranchiseAllocation[]> {
  const { start, end } = istMonthBounds(month);
  const rows = await client.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.isTest, false), sql`${franchiseAllocations.activatedAt} < ${end.toISOString()}::timestamptz`));
  return rows.filter((a) => {
    const stop = earningEnd(a);
    return a.status !== "CANCELLED" && (!stop || stop.getTime() >= start.getTime());
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
 * Calculates (or recalculates) every dealer code's month and stores the DRAFT snapshots (brief 21-Nov §5, days 1–3).
 * Idempotent and rerunnable until the month is locked; a LOCKED snapshot is never touched.
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
 * Locks `month` (brief 21-Nov §5, the 5th): recalculates each DRAFT one last time, writes its per-shop ledger lines
 * (RECURRING_BASE, RECURRING_BONUS, negative adjustments) dated inside the month so the payout close pays them, and
 * marks it LOCKED. Later corrections go to the next month's adjustments. Idempotent.
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
          note: `${month} · code ${c.code ?? "—"} · area ${s.zoneId} · ${note}`,
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
        await write(l.shopId, "RECURRING_BASE", l.basePaise, `FRR:${s.allocationId}:${l.shopId}:${month}`, `₹${(l.netPaise / 100).toLocaleString("en-IN")} delivered × 2% × ${c.result.commissionRateBp - c.result.bonusBp} bp`);
        await write(l.shopId, "RECURRING_BONUS", l.bonusPaise, `FRB:${s.allocationId}:${l.shopId}:${month}`, `bonus ${c.result.bonusBp} bp (${c.result.mainPoints} main points)`, c.result.bonusBp);
        await write(l.shopId, "RECURRING_BASE", l.adjustmentPaise, `FRA:${s.allocationId}:${l.shopId}:${month}`, "refund after an earlier payout");
      }
      await tx.update(franchiseMonthlySnapshots).set({ ...snapshotValues(c), status: "LOCKED", lockedAt: new Date(), lockedBy: actor?.id ?? null }).where(eq(franchiseMonthlySnapshots.id, s.id));
      locked++;
    });
  }
  await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_COMMISSION, entityType: "franchise_month", entityId: month, newValue: { locked, entries } });
  return { locked, entries };
}

/** Live month-to-date for the dashboard (brief 21-Nov §7): the same calculation on the month so far, not stored. */
export async function liveMonth(allocation: FranchiseAllocation, now: Date): Promise<SnapshotCalc> {
  return calculateAllocationMonth(db, allocation, istMonth(now));
}

/** The franchise owner a shop is attributed to (any status but REVERSED), or null. */
export async function franchiseOwnerOf(client: DbClient, shopId: string): Promise<string | null> {
  const [r] = await client.select({ owner: franchiseShopAttributions.ownerDealerId, status: franchiseShopAttributions.status }).from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  return r && r.status !== "REVERSED" ? r.owner : null;
}
