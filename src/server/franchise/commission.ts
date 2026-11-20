/**
 * Franchise (Model B) commission (brief §3, §8): one-time 25% of each activated shop's fee (excluding GST) and,
 * every month, 25% (+ a 0–5 point bonus) of GoKesari's actual order commission on the shops attributed to the
 * owner's allocation, while it is active or in its tail. Entries go to the existing dealer ledger
 * (dealer_commission_ledger) with the owner as payee, so the existing monthly close, payout batch, TDS and
 * statements carry them unchanged. Nothing is ever updated in place: corrections are new entries.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { bpOf, istMonthBounds } from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  financialAdjustments,
  franchiseAllocations,
  franchiseCalcRuns,
  franchisePerformanceRatings,
  franchiseRatingFormulas,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  orderFinancials,
  shops,
  type DealerCommissionEntry,
  type UserRole,
} from "@/server/db/schema";
import { feeBasePaise, getCommissionSettings } from "@/server/dealers/commission";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { franchiseConfigAt, franchiseNow, franchiseConfig } from "./config";

interface Actor {
  id: string;
  role: UserRole;
}

const commissionOnPaise = (goodsPaise: number, rateBp: number) => Math.round((Math.max(0, goodsPaise) * rateBp) / 10_000);

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

/* ============================================================= rating engine (bonus) */

export interface RatingFormula {
  /** Metric → weight and the value that scores 100% on it. */
  metrics: { key: RatingMetric; weight: number; target: number }[];
  /** Score (0–100) → bonus in basis points (100 = 1 percentage point); the highest tier reached applies. */
  tiers: { minScore: number; bonusBp: number }[];
}

export const RATING_METRICS = ["newShopsActivated", "activeShops", "attributedGmvPaise", "momGrowthPct", "ticketCompliancePct"] as const;
export type RatingMetric = (typeof RATING_METRICS)[number];

export const RATING_METRIC_LABELS: Record<RatingMetric, string> = {
  newShopsActivated: "new shops activated in the month",
  activeShops: "shops with at least one completed order in the month",
  attributedGmvPaise: "order value of your shops in the month",
  momGrowthPct: "growth in order value over the previous month (%)",
  ticketCompliancePct: "support tickets raised within 24 hours (%)",
};

/** Score 0–100 and the tier bonus (capped), with a plain-language explanation (brief §8.3). */
export function scoreOwner(formula: RatingFormula | null, metrics: Record<RatingMetric, number>, bonusMaxBp: number): { score: number; bonusBp: number; explanation: string } {
  if (!formula || !formula.metrics.length) return { score: 0, bonusBp: 0, explanation: "No performance formula has been published yet, so your bonus this month is 0%." };
  const totalWeight = formula.metrics.reduce((s, m) => s + Math.max(0, m.weight), 0) || 1;
  const parts = formula.metrics.map((m) => {
    const value = metrics[m.key] ?? 0;
    const ratio = m.target > 0 ? Math.max(0, Math.min(1, value / m.target)) : 0;
    return { ...m, value, points: (ratio * Math.max(0, m.weight) * 100) / totalWeight };
  });
  const score = Math.round(parts.reduce((s, p) => s + p.points, 0) * 100) / 100;
  const tier = [...formula.tiers].sort((a, b) => b.minScore - a.minScore).find((t) => score >= t.minScore);
  const bonusBp = Math.min(bonusMaxBp, Math.max(0, tier?.bonusBp ?? 0));
  const lines = parts.map((p) => `${RATING_METRIC_LABELS[p.key]}: ${p.key === "attributedGmvPaise" ? `₹${Math.round(p.value / 100).toLocaleString("en-IN")}` : Math.round(p.value * 100) / 100} of a target ${p.key === "attributedGmvPaise" ? `₹${Math.round(p.target / 100).toLocaleString("en-IN")}` : p.target} → ${p.points.toFixed(1)} points`);
  const next = [...formula.tiers].sort((a, b) => a.minScore - b.minScore).find((t) => t.minScore > score && t.bonusBp > bonusBp);
  return {
    score,
    bonusBp,
    explanation: `Score ${score.toFixed(1)} / 100 → bonus ${bonusBp / 100} percentage points. ${lines.join("; ")}.${next ? ` Reach ${next.minScore} points for ${next.bonusBp / 100} points of bonus.` : ""}`,
  };
}

export async function publishedFormula(client: DbClient = db): Promise<{ version: number; formula: RatingFormula } | null> {
  const [row] = await client.select().from(franchiseRatingFormulas).where(eq(franchiseRatingFormulas.status, "PUBLISHED")).orderBy(sql`${franchiseRatingFormulas.version} desc`).limit(1);
  return row ? { version: row.version, formula: row.formula as unknown as RatingFormula } : null;
}

/** Saves a formula version; publish = it applies from the next monthly run (the previous one is retired). */
export async function saveRatingFormula(formula: RatingFormula, publish: boolean, reason: string, actor: Actor): Promise<number> {
  if (actor.role !== "ADMIN") throw new Error("Only an admin can change the bonus formula.");
  if (reason.trim().length < 5) throw new Error("Give a reason of at least 5 characters.");
  for (const m of formula.metrics) if (!RATING_METRICS.includes(m.key) || !(m.weight >= 0) || !(m.target > 0)) throw new Error(`Check metric ${m.key}: weight ≥ 0 and target > 0.`);
  for (const t of formula.tiers) if (!(t.minScore >= 0 && t.minScore <= 100) || !(t.bonusBp >= 0 && t.bonusBp <= 10_000)) throw new Error("Each tier needs a score 0–100 and a bonus 0–10000 bp.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-rating'))`);
    const [m] = (await tx.execute(sql`select coalesce(max(version), 0)::int as v from franchise_rating_formulas`)) as unknown as { v: number }[];
    const version = Number(m?.v ?? 0) + 1;
    if (publish) await tx.update(franchiseRatingFormulas).set({ status: "RETIRED" }).where(eq(franchiseRatingFormulas.status, "PUBLISHED"));
    await tx.insert(franchiseRatingFormulas).values({ version, status: publish ? "PUBLISHED" : "DRAFT", formula: formula as unknown as Record<string, unknown>, reason, publishedAt: publish ? new Date() : null, publishedBy: publish ? actor.id : null, createdBy: actor.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_rating_formula", entityId: String(version), newValue: { formula, publish, reason } }, tx);
    return version;
  });
}

async function ownerMetrics(client: DbClient, ownerId: string, month: string): Promise<Record<RatingMetric, number>> {
  const b = istMonthBounds(month);
  const p = istMonthBounds(prevMonth(month));
  const [start, end, prevStart, prevEnd] = [b.start.toISOString(), b.end.toISOString(), p.start.toISOString(), p.end.toISOString()];
  const [r] = (await client.execute(sql`
    select
      (select count(*)::int from ${franchiseShopAttributions} fa where fa.owner_dealer_id = ${ownerId} and fa.activated_at >= ${start}::timestamptz and fa.activated_at < ${end}::timestamptz) as new_shops,
      (select count(distinct o.shop_id)::int from ${orderFinancials} o join ${franchiseShopAttributions} fa on fa.shop_id = o.shop_id where fa.owner_dealer_id = ${ownerId} and fa.status = 'ACTIVE' and o.delivered_at >= ${start}::timestamptz and o.delivered_at < ${end}::timestamptz) as active_shops,
      (select coalesce(sum(o.goods_paise), 0)::bigint from ${orderFinancials} o join ${franchiseShopAttributions} fa on fa.shop_id = o.shop_id where fa.owner_dealer_id = ${ownerId} and fa.status = 'ACTIVE' and o.delivered_at >= ${start}::timestamptz and o.delivered_at < ${end}::timestamptz) as gmv,
      (select coalesce(sum(o.goods_paise), 0)::bigint from ${orderFinancials} o join ${franchiseShopAttributions} fa on fa.shop_id = o.shop_id where fa.owner_dealer_id = ${ownerId} and fa.status = 'ACTIVE' and o.delivered_at >= ${prevStart}::timestamptz and o.delivered_at < ${prevEnd}::timestamptz) as gmv_prev
  `)) as unknown as { new_shops: number; active_shops: number; gmv: string | number; gmv_prev: string | number }[];
  const gmv = Number(r?.gmv ?? 0);
  const gmvPrev = Number(r?.gmv_prev ?? 0);
  return {
    newShopsActivated: Number(r?.new_shops ?? 0),
    activeShops: Number(r?.active_shops ?? 0),
    attributedGmvPaise: gmv,
    momGrowthPct: gmvPrev > 0 ? Math.round(((gmv - gmvPrev) / gmvPrev) * 10_000) / 100 : gmv > 0 ? 100 : 0,
    // Ticket timing is not recorded per franchise yet: full marks until it is (brief §8.3 lists the metric).
    ticketCompliancePct: 100,
  };
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Rates every owner with an allocation for `month` (written once; re-running keeps the first result). */
export async function rateOwnersForMonth(month: string, client: DbClient = db): Promise<number> {
  const { config } = await franchiseConfigAt(istMonthBounds(month).end, client);
  const f = await publishedFormula(client);
  const owners = await client.selectDistinct({ id: franchiseAllocations.ownerDealerId }).from(franchiseAllocations).where(and(eq(franchiseAllocations.isTest, false), sql`${franchiseAllocations.activatedAt} is not null`));
  let n = 0;
  for (const o of owners) {
    const metrics = await ownerMetrics(client, o.id, month);
    const s = scoreOwner(f?.formula ?? null, metrics, config.bonusMaxBp);
    const ins = await client
      .insert(franchisePerformanceRatings)
      .values({ ownerDealerId: o.id, month, formulaVersion: f?.version ?? null, score: s.score, bonusBp: s.bonusBp, metrics, explanation: s.explanation })
      .onConflictDoNothing()
      .returning();
    n += ins.length;
  }
  return n;
}

/* ============================================================= monthly recurring */

interface ShopMonth {
  shopId: string;
  ownerDealerId: string;
  allocationId: string;
  zoneId: string;
  launchOffer: boolean;
  commissionPaise: number;
  refundedPaise: number;
  orders: number;
}

/**
 * GoKesari's commission on each attributed shop's orders delivered in `month`, minus the commission on refunds
 * recorded in `month` (brief §8.2: "net of cancellations, returns and refunds in the month"). Only orders
 * delivered while the allocation earns: from activation to its tail end (or termination).
 */
export async function franchiseShopMonths(client: DbClient, month: string): Promise<ShopMonth[]> {
  const b = istMonthBounds(month);
  const [start, end] = [b.start.toISOString(), b.end.toISOString()];
  const earning = sql`o.delivered_at >= a.activated_at and o.delivered_at <= coalesce(case when a.status in ('TERMINATED', 'CANCELLED') then a.ended_at end, a.tail_end_at, a.expires_at)`;
  const delivered = (await client.execute(sql`
    select fa.shop_id, fa.owner_dealer_id, fa.allocation_id, fa.zone_id, a.launch_offer,
           coalesce(sum(o.commission_paise), 0)::bigint as commission, count(*)::int as orders
    from ${franchiseShopAttributions} fa
    join ${franchiseAllocations} a on a.id = fa.allocation_id and not a.is_test and a.status <> 'CANCELLED'
    join ${orderFinancials} o on o.shop_id = fa.shop_id
    where fa.status = 'ACTIVE' and o.delivered_at >= ${start}::timestamptz and o.delivered_at < ${end}::timestamptz and ${earning}
    group by 1, 2, 3, 4, 5
  `)) as unknown as { shop_id: string; owner_dealer_id: string; allocation_id: string; zone_id: string; launch_offer: boolean; commission: string | number; orders: number }[];
  const refunds = (await client.execute(sql`
    select fa.shop_id, fa.owner_dealer_id, fa.allocation_id, fa.zone_id, a.launch_offer, adj.customer_refund_paise as refund, o.goods_paise as goods, o.commission_rate_bp as rate_bp, o.commission_paise as commission
    from ${financialAdjustments} adj
    join ${orderFinancials} o on o.order_id = adj.order_id
    join ${franchiseShopAttributions} fa on fa.shop_id = o.shop_id and fa.status = 'ACTIVE'
    join ${franchiseAllocations} a on a.id = fa.allocation_id and not a.is_test and a.status <> 'CANCELLED'
    where adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM') and adj.created_at >= ${start}::timestamptz and adj.created_at < ${end}::timestamptz and ${earning}
  `)) as unknown as { shop_id: string; owner_dealer_id: string; allocation_id: string; zone_id: string; launch_offer: boolean; refund: string | number; goods: string | number; rate_bp: number; commission: string | number }[];
  const map = new Map<string, ShopMonth>();
  const key = (r: { shop_id: string; allocation_id: string }) => `${r.shop_id}:${r.allocation_id}`;
  for (const r of delivered) map.set(key(r), { shopId: r.shop_id, ownerDealerId: r.owner_dealer_id, allocationId: r.allocation_id, zoneId: r.zone_id, launchOffer: r.launch_offer, commissionPaise: Number(r.commission), refundedPaise: 0, orders: Number(r.orders) });
  for (const r of refunds) {
    const k = key(r);
    const row = map.get(k) ?? { shopId: r.shop_id, ownerDealerId: r.owner_dealer_id, allocationId: r.allocation_id, zoneId: r.zone_id, launchOffer: r.launch_offer, commissionPaise: 0, refundedPaise: 0, orders: 0 };
    row.refundedPaise += Math.min(Number(r.commission), commissionOnPaise(Math.min(Number(r.refund), Number(r.goods)), Number(r.rate_bp)));
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => a.ownerDealerId.localeCompare(b.ownerDealerId) || a.shopId.localeCompare(b.shopId));
}

/**
 * Writes the month's RECURRING_BASE (and RECURRING_BONUS) entries, one per shop, dated inside the month so the
 * close on the 5th pays them. Idempotent (accrual keys FRR / FRB). A negative month (refunds above the month's
 * commission) is written as an ADJUSTMENT and taken from the payout.
 */
export async function accrueFranchiseRecurring(client: DbClient, month: string, runId: string, actor: Actor | null = null): Promise<{ entries: number; basePaise: number; bonusPaise: number }> {
  const { end } = istMonthBounds(month);
  const dated = new Date(end.getTime() - 1000);
  const { version, config } = await franchiseConfigAt(dated, client);
  const rows = await franchiseShopMonths(client, month);
  if (!rows.length) return { entries: 0, basePaise: 0, bonusPaise: 0 };
  const ratings = new Map(
    (await client.select().from(franchisePerformanceRatings).where(and(eq(franchisePerformanceRatings.month, month), inArray(franchisePerformanceRatings.ownerDealerId, [...new Set(rows.map((r) => r.ownerDealerId))])))).map((r) => [r.ownerDealerId, r.bonusBp]),
  );
  const ownerStatus = new Map((await client.select({ id: dealers.id, status: dealers.status }).from(dealers).where(inArray(dealers.id, [...new Set(rows.map((r) => r.ownerDealerId))]))).map((d) => [d.id, d.status]));
  let entries = 0;
  let baseTotal = 0;
  let bonusTotal = 0;
  for (const r of rows) {
    const net = r.commissionPaise - r.refundedPaise;
    if (net === 0) continue;
    const baseBp = !r.launchOffer && config.postLaunchRecurringBp != null ? config.postLaunchRecurringBp : config.recurringBaseBp;
    const bonusBp = Math.min(config.bonusMaxBp, ratings.get(r.ownerDealerId) ?? 0);
    const held = ownerStatus.get(r.ownerDealerId) !== "APPROVED";
    const write = async (entryType: "RECURRING_BASE" | "RECURRING_BONUS", bp: number, accrualKey: string) => {
      const amount = Math.sign(net) * bpOf(Math.abs(net), bp);
      if (amount === 0) return 0;
      const [exists] = await client.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(eq(dealerCommissionLedger.accrualKey, accrualKey));
      if (exists) return 0;
      await client
        .insert(dealerCommissionLedger)
        .values({
          dealerId: r.ownerDealerId,
          shopId: r.shopId,
          milestone: "MONTHLY",
          kind: amount > 0 ? "ACCRUAL" : "ADJUSTMENT",
          entryType,
          level: 1,
          accrualKey,
          feePaise: 0,
          basePaise: net,
          bonusBp: entryType === "RECURRING_BONUS" ? bp : 0,
          bonusPaise: entryType === "RECURRING_BONUS" ? amount : 0,
          amountPaise: amount,
          status: held ? "ON_HOLD" : "EARNED",
          heldFromStatus: held ? "EARNED" : null,
          note: `${month}: GoKesari commission ₹${(r.commissionPaise / 100).toFixed(2)} on ${r.orders} order(s)${r.refundedPaise ? ` − ₹${(r.refundedPaise / 100).toFixed(2)} on refunds` : ""} × ${bp / 100}% — zone ${r.zoneId}`,
          franchiseAllocationId: r.allocationId,
          franchiseZoneId: r.zoneId,
          configVersion: version,
          calcRunId: runId,
          createdAt: dated,
          createdBy: actor?.id ?? null,
        })
        .onConflictDoNothing();
      entries += 1;
      return amount;
    };
    baseTotal += await write("RECURRING_BASE", baseBp, `FRR:${r.shopId}:${r.allocationId}:${month}`);
    if (bonusBp > 0) bonusTotal += await write("RECURRING_BONUS", bonusBp, `FRB:${r.shopId}:${r.allocationId}:${month}`);
  }
  if (entries) {
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_COMMISSION, entityType: "franchise_month", entityId: month, newValue: { runId, entries, basePaise: baseTotal, bonusPaise: bonusTotal, configVersion: version } }, client);
  }
  return { entries, basePaise: baseTotal, bonusPaise: bonusTotal };
}

/**
 * The monthly run for `month` (brief §8.2): ratings, then recurring entries. Run once (franchise_calc_runs);
 * an admin may run it again (`force`), which only adds what is missing.
 */
export async function runFranchiseMonth(month: string, actor: Actor | null = null, options: { force?: boolean } = {}): Promise<{ skipped?: string; rated?: number; entries?: number; basePaise?: number; bonusPaise?: number }> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM.");
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  if (istMonthBounds(month).end.getTime() > now.getTime()) return { skipped: `${month} is not over yet` };
  const id = `MONTHLY:${month}`;
  const [existing] = await db.select().from(franchiseCalcRuns).where(eq(franchiseCalcRuns.id, id));
  if (existing?.status === "DONE" && !options.force) return { skipped: `${month} already calculated` };
  if (!existing) await db.insert(franchiseCalcRuns).values({ id, month, kind: "MONTHLY", createdBy: actor?.id ?? null }).onConflictDoNothing();
  try {
    const rated = await rateOwnersForMonth(month);
    const runId = `${id}:${now.toISOString()}`;
    const r = await db.transaction((tx) => accrueFranchiseRecurring(tx, month, runId, actor));
    await db.update(franchiseCalcRuns).set({ status: "DONE", finishedAt: new Date(), summary: { rated, ...r, runId } }).where(eq(franchiseCalcRuns.id, id));
    return { rated, ...r };
  } catch (e) {
    await db.update(franchiseCalcRuns).set({ status: "FAILED", finishedAt: new Date(), summary: { error: e instanceof Error ? e.message : String(e) } }).where(eq(franchiseCalcRuns.id, id));
    throw e;
  }
}

/** The franchise owner a shop is attributed to (any status but REVERSED), or null. */
export async function franchiseOwnerOf(client: DbClient, shopId: string): Promise<string | null> {
  const [r] = await client.select({ owner: franchiseShopAttributions.ownerDealerId, status: franchiseShopAttributions.status }).from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  return r && r.status !== "REVERSED" ? r.owner : null;
}
