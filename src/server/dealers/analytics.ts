/**
 * Dealer programme P1 analytics (docs/dealer-programme, step 8):
 *  - GKS-GEO-001 coverage: per area — active dealers, shops onboarded, target
 *    vs registered, registered but not operational, under-covered areas;
 *  - GKS-AN-001 performance score: weighted (admin-set weights, rule
 *    dealerPerformanceScore), each dealer compared with dealers of the same
 *    district — for analysis and ranking only (the rating drives commission);
 *  - GKS-AN-002 activation and 30-day order activity per dealer and employee.
 *
 * Read-only. Areas come from geo_areas; a shop belongs to the area its PIN
 * code resolves to (longest prefix) and to every area above it.
 */
import { and, eq, gte, inArray, notInArray, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  dealerSalespeople,
  dealerTerritories,
  geoAreaPincodes,
  geoAreas,
  geoAreaTargets,
  orders,
  shopAttributions,
  shops,
} from "@/server/db/schema";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import type { RuleValue } from "@/server/config/rules";
import { getRule } from "@/server/services/settings";

const DAY = 86_400_000;
/** Orders that did not happen: they do not count as activity. */
const NOT_AN_ORDER = ["CANCELLED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"] as const;

interface AreaNode {
  code: string;
  name: string;
  level: string;
  parentCode: string | null;
}

/** Areas, a PIN → area resolver, and each area's chain up to the state. */
async function areaIndex() {
  const [prefixes, areas] = await Promise.all([db.select().from(geoAreaPincodes), db.select().from(geoAreas).where(eq(geoAreas.status, "ACTIVE"))]);
  const byCode = new Map<string, AreaNode>(areas.map((a) => [a.code, a]));
  const sorted = [...prefixes].filter((p) => byCode.has(p.areaCode)).sort((a, b) => b.pincodePrefix.length - a.pincodePrefix.length);
  const chain = (code: string | null): string[] => {
    const out: string[] = [];
    for (let cur = code ? byCode.get(code) : undefined, i = 0; cur && i < 8; cur = cur.parentCode ? byCode.get(cur.parentCode) : undefined, i++) out.push(cur.code);
    return out;
  };
  const resolve = (pin: string | null): string | null => (pin ? (sorted.find((p) => pin.startsWith(p.pincodePrefix))?.areaCode ?? null) : null);
  const districtOf = (code: string | null): AreaNode | null => {
    for (const c of chain(code)) if (byCode.get(c)?.level === "DISTRICT") return byCode.get(c)!;
    return null;
  };
  return { byCode, chain, resolve, districtOf };
}

/* ================================================================ coverage */

export type CoverageStatus = "NO_DEALER" | "UNDER_TARGET" | "NOT_OPERATIONAL" | "COVERED" | "NO_TARGET";

export interface CoverageRow {
  code: string;
  name: string;
  level: string;
  parentCode: string | null;
  activeDealers: number;
  shops: number;
  /** Shops brought by a dealer (attributed). */
  dealerShops: number;
  operational: number;
  /** Registered but not live, or live without an order in 30 days. */
  notOperational: number;
  target: number | null;
  status: CoverageStatus;
  /** Average position of the area's shops (for the drawn map), when any shop has one. */
  latitude: number | null;
  longitude: number | null;
}

/**
 * Coverage of every active area under `rootCode` (default: the whole state),
 * at every level. Status: no approved dealer covers it → NO_DEALER; fewer
 * shops than the target → UNDER_TARGET;
 * half or more of its shops not operational → NOT_OPERATIONAL; otherwise
 * COVERED (or NO_TARGET when no target was set).
 */
export async function coverageReport(rootCode?: string | null, now = new Date()): Promise<CoverageRow[]> {
  const idx = await areaIndex();
  if (rootCode && !idx.byCode.has(rootCode)) throw notFound("Area");
  const since = new Date(now.getTime() - 30 * DAY);
  const [shopRows, recentOrders, territories, targets, attributed] = await Promise.all([
    db
      .select({ id: shops.id, pincode: shops.pincode, lifecycle: shops.lifecycleStatus, status: shops.status, lat: shops.latitude, lng: shops.longitude })
      .from(shops)
      .where(notInArray(shops.status, ["REJECTED"])),
    db
      .select({ shopId: orders.shopId })
      .from(orders)
      .where(and(gte(orders.createdAt, since), notInArray(orders.status, [...NOT_AN_ORDER])))
      .groupBy(orders.shopId),
    db
      .select({ dealerId: dealerTerritories.dealerId, areaCode: dealerTerritories.areaCode })
      .from(dealerTerritories)
      .innerJoin(dealers, eq(dealers.id, dealerTerritories.dealerId))
      .where(eq(dealers.status, "APPROVED")),
    db.select().from(geoAreaTargets),
    db.select({ shopId: shopAttributions.shopId }).from(shopAttributions).where(eq(shopAttributions.status, "ACTIVE")),
  ]);
  const ordered = new Set(recentOrders.map((o) => o.shopId));
  const fromDealer = new Set(attributed.map((a) => a.shopId));
  const targetOf = new Map(targets.map((t) => [t.areaCode, t.targetShops]));

  // Dealers covering an area: a territory on the area itself or on any area above it.
  const dealersAt = new Map<string, Set<string>>();
  for (const t of territories) {
    const set = dealersAt.get(t.areaCode) ?? new Set<string>();
    set.add(t.dealerId);
    dealersAt.set(t.areaCode, set);
  }
  const coveringDealers = (code: string) => {
    const all = new Set<string>();
    for (const c of idx.chain(code)) for (const d of dealersAt.get(c) ?? []) all.add(d);
    // A dealer whose territory is inside this area covers part of it too.
    for (const [areaCode, set] of dealersAt) if (idx.chain(areaCode).includes(code)) for (const d of set) all.add(d);
    return all.size;
  };

  const tally = new Map<string, { shops: number; dealerShops: number; operational: number; lat: number; lng: number; located: number }>();
  for (const s of shopRows) {
    const live = s.lifecycle === "ACTIVE" && s.status === "APPROVED";
    const operational = live && ordered.has(s.id);
    for (const code of idx.chain(idx.resolve(s.pincode))) {
      const t = tally.get(code) ?? { shops: 0, dealerShops: 0, operational: 0, lat: 0, lng: 0, located: 0 };
      t.shops += 1;
      if (fromDealer.has(s.id)) t.dealerShops += 1;
      if (operational) t.operational += 1;
      if (s.lat != null && s.lng != null) {
        t.lat += Number(s.lat);
        t.lng += Number(s.lng);
        t.located += 1;
      }
      tally.set(code, t);
    }
  }

  const rows: CoverageRow[] = [];
  for (const area of idx.byCode.values()) {
    if (rootCode && !idx.chain(area.code).includes(rootCode)) continue;
    const t = tally.get(area.code);
    const shopsHere = t?.shops ?? 0;
    const target = targetOf.get(area.code) ?? null;
    const activeDealers = coveringDealers(area.code);
    const notOperational = shopsHere - (t?.operational ?? 0);
    const status: CoverageStatus =
      activeDealers === 0
        ? "NO_DEALER"
        : target != null && shopsHere < target
          ? "UNDER_TARGET"
          : shopsHere > 0 && notOperational * 2 >= shopsHere
            ? "NOT_OPERATIONAL"
            : target == null
              ? "NO_TARGET"
              : "COVERED";
    rows.push({
      code: area.code,
      name: area.name,
      level: area.level,
      parentCode: area.parentCode,
      activeDealers,
      shops: shopsHere,
      dealerShops: t?.dealerShops ?? 0,
      operational: t?.operational ?? 0,
      notOperational,
      target,
      status,
      latitude: t?.located ? t.lat / t.located : null,
      longitude: t?.located ? t.lng / t.located : null,
    });
  }
  const levelRank: Record<string, number> = { STATE: 0, REGION: 1, DISTRICT: 2, TALUKA: 3, LOCALITY: 4 };
  return rows.sort((a, b) => (levelRank[a.level] ?? 9) - (levelRank[b.level] ?? 9) || b.shops - a.shops || a.name.localeCompare(b.name));
}

/** ADMIN only: the target number of shops for an area (null removes it). Audited. */
export async function setAreaTarget(areaCode: string, targetShops: number | null, note: string, actor: { id: string; role: string }) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can set area targets.");
  const [area] = await db.select({ code: geoAreas.code }).from(geoAreas).where(eq(geoAreas.code, areaCode));
  if (!area) throw notFound("Area");
  const [before] = await db.select().from(geoAreaTargets).where(eq(geoAreaTargets.areaCode, areaCode));
  if (targetShops == null) {
    await db.delete(geoAreaTargets).where(eq(geoAreaTargets.areaCode, areaCode));
  } else {
    if (!Number.isInteger(targetShops) || targetShops < 0 || targetShops > 100_000) throw validationFailed("Target: 0 to 100,000 shops.");
    const values = { targetShops, note: note.trim().slice(0, 300) || null, updatedBy: actor.id, updatedAt: new Date() };
    // Seller table with one unique key: insert, else update (no ON CONFLICT target — two-database layout).
    const inserted = await db.insert(geoAreaTargets).values({ areaCode, ...values }).onConflictDoNothing().returning();
    if (inserted.length === 0) await db.update(geoAreaTargets).set(values).where(eq(geoAreaTargets.areaCode, areaCode));
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.GEO_AREA_TARGET_SET,
    entityType: "geo_area",
    entityId: areaCode,
    previousValue: before ? { targetShops: before.targetShops } : null,
    newValue: { targetShops, note: note.trim().slice(0, 300) || null },
  });
}

/* ============================================ activation and 30-day activity */

export interface ActivationRow {
  dealerId: string;
  dealerName: string;
  /** null: the dealer's own row (all its shops); otherwise one employee ("—" = no employee named). */
  salespersonId: string | null;
  salespersonName: string | null;
  registered: number;
  activated: number;
  activationRate: number;
  /** Live shops with at least one order in the last 30 days. */
  active30: number;
  activityRate: number;
  orders30: number;
  avgDaysToActivate: number | null;
}

/** Per dealer, and per employee within each dealer (GKS-AN-002). `dealerId` limits it to one dealer. */
export async function activationReport(dealerId?: string | null, now = new Date()): Promise<ActivationRow[]> {
  const since = new Date(now.getTime() - 30 * DAY);
  const where = dealerId ? and(eq(shopAttributions.status, "ACTIVE"), eq(shopAttributions.dealerId, dealerId)) : eq(shopAttributions.status, "ACTIVE");
  const attrs = await db
    .select({
      shopId: shopAttributions.shopId,
      dealerId: shopAttributions.dealerId,
      dealerName: dealers.legalName,
      salespersonId: shopAttributions.salespersonId,
      createdAt: shopAttributions.createdAt,
      activatedAt: shopAttributions.activatedAt,
    })
    .from(shopAttributions)
    .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
    .where(where);
  const shopIds = attrs.map((a) => a.shopId);
  const [orderCounts, people] = await Promise.all([
    shopIds.length
      ? db
          .select({ shopId: orders.shopId, n: sql<number>`count(*)::int` })
          .from(orders)
          .where(and(inArray(orders.shopId, shopIds), gte(orders.createdAt, since), notInArray(orders.status, [...NOT_AN_ORDER])))
          .groupBy(orders.shopId)
      : Promise.resolve([] as { shopId: string; n: number }[]),
    db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name, employeeId: dealerSalespeople.employeeId }).from(dealerSalespeople),
  ]);
  const ordersOf = new Map(orderCounts.map((o) => [o.shopId, o.n]));
  const personOf = new Map(people.map((p) => [p.id, `${p.name} (${p.employeeId})`]));

  const groups = new Map<string, { row: Omit<ActivationRow, "activationRate" | "activityRate" | "avgDaysToActivate">; days: number[] }>();
  const add = (key: string, base: Pick<ActivationRow, "dealerId" | "dealerName" | "salespersonId" | "salespersonName">, a: (typeof attrs)[number]) => {
    const g = groups.get(key) ?? { row: { ...base, registered: 0, activated: 0, active30: 0, orders30: 0 }, days: [] };
    g.row.registered += 1;
    if (a.activatedAt) {
      g.row.activated += 1;
      g.days.push((a.activatedAt.getTime() - a.createdAt.getTime()) / DAY);
      const n = ordersOf.get(a.shopId) ?? 0;
      if (n > 0) g.row.active30 += 1;
      g.row.orders30 += n;
    }
    groups.set(key, g);
  };
  for (const a of attrs) {
    add(`d:${a.dealerId}`, { dealerId: a.dealerId, dealerName: a.dealerName, salespersonId: null, salespersonName: null }, a);
    add(`s:${a.dealerId}:${a.salespersonId ?? "-"}`, { dealerId: a.dealerId, dealerName: a.dealerName, salespersonId: a.salespersonId ?? "-", salespersonName: a.salespersonId ? (personOf.get(a.salespersonId) ?? "Employee") : "No employee named" }, a);
  }
  const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
  return [...groups.values()]
    .map(({ row, days }) => ({
      ...row,
      activationRate: pct(row.activated, row.registered),
      activityRate: pct(row.active30, row.activated),
      avgDaysToActivate: days.length ? Math.round((10 * days.reduce((s, d) => s + d, 0)) / days.length) / 10 : null,
    }))
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName) || (a.salespersonId === null ? -1 : b.salespersonId === null ? 1 : b.registered - a.registered));
}

/* ======================================================== performance score */

export interface ScoreRow {
  dealerId: string;
  dealerName: string;
  isInternal: boolean;
  /** Dealers are compared within their district (from the dealer's PIN code). */
  peerGroup: string;
  rank: number;
  peers: number;
  score: number;
  components: { activatedShops: number; registrationQuality: number; activity30: number; costPerActivatedShop: number; coverage: number };
  facts: { registered: number; activated: number; poorRegistrations: number; active30: number; commissionPaise: number; costPerActivatedPaise: number | null; territoryAreas: number; areasWithShops: number };
}

/**
 * Weighted score 0–100 per approved dealer (GKS-AN-001). Each part is 0–1:
 * activated shops and cost are measured against the best dealer in the same
 * district; quality, activity and coverage are the dealer's own ratios.
 */
export async function dealerScores(now = new Date()): Promise<{ weights: RuleValue<"dealerPerformanceScore">; rows: ScoreRow[] }> {
  const weights = await getRule("dealerPerformanceScore");
  const idx = await areaIndex();
  const since = new Date(now.getTime() - 30 * DAY);
  const [list, attrs, money, territories] = await Promise.all([
    db.select().from(dealers).where(eq(dealers.status, "APPROVED")),
    db
      .select({
        dealerId: shopAttributions.dealerId,
        shopId: shopAttributions.shopId,
        status: shopAttributions.status,
        matchKind: shopAttributions.matchKind,
        activatedAt: shopAttributions.activatedAt,
        shopStatus: shops.status,
        pincode: shops.pincode,
      })
      .from(shopAttributions)
      .innerJoin(shops, eq(shops.id, shopAttributions.shopId)),
    db
      .select({ dealerId: dealerCommissionLedger.dealerId, earned: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} <> 'REVERSED'), 0)::int` })
      .from(dealerCommissionLedger)
      .groupBy(dealerCommissionLedger.dealerId),
    db.select().from(dealerTerritories),
  ]);
  const activeShopIds = attrs.filter((a) => a.status === "ACTIVE" && a.activatedAt).map((a) => a.shopId);
  const ordered = new Set(
    activeShopIds.length
      ? (
          await db
            .select({ shopId: orders.shopId })
            .from(orders)
            .where(and(inArray(orders.shopId, activeShopIds), gte(orders.createdAt, since), notInArray(orders.status, [...NOT_AN_ORDER])))
            .groupBy(orders.shopId)
        ).map((o) => o.shopId)
      : [],
  );
  const earnedOf = new Map(money.map((m) => [m.dealerId, m.earned]));

  const facts = list.map((d) => {
    const mine = attrs.filter((a) => a.dealerId === d.id);
    const live = mine.filter((a) => a.status === "ACTIVE");
    const activated = live.filter((a) => a.activatedAt);
    const poor = mine.filter((a) => a.status === "REVERSED" || a.matchKind === "DUPLICATE" || a.shopStatus === "REJECTED").length;
    const commission = earnedOf.get(d.id) ?? 0;
    const terr = territories.filter((t) => t.dealerId === d.id).map((t) => t.areaCode);
    // Areas of the territory (a district counts its talukas and localities) with at least one of the dealer's shops.
    // Duplicates and rejected shops do not cover an area.
    const shopAreas = new Set(live.filter((a) => a.matchKind !== "DUPLICATE" && a.shopStatus !== "REJECTED").flatMap((a) => idx.chain(idx.resolve(a.pincode))));
    const territoryAreas = new Set<string>();
    for (const code of terr) {
      territoryAreas.add(code);
      for (const area of idx.byCode.values()) if (area.code !== code && idx.chain(area.code).includes(code)) territoryAreas.add(area.code);
    }
    const withShops = [...territoryAreas].filter((c) => shopAreas.has(c)).length;
    const district = idx.districtOf(idx.resolve(d.pincode));
    return {
      d,
      peerGroup: d.isInternal ? "GoKesari Direct" : (district?.name ?? "District not known"),
      registered: mine.length,
      activated: activated.length,
      poor,
      active30: activated.filter((a) => ordered.has(a.shopId)).length,
      commission,
      cost: activated.length ? commission / activated.length : null,
      territoryAreas: territoryAreas.size,
      withShops,
    };
  });

  const rows: ScoreRow[] = facts.map((f) => {
    const peers = facts.filter((p) => p.peerGroup === f.peerGroup);
    const bestActivated = Math.max(0, ...peers.map((p) => p.activated));
    const costs = peers.map((p) => p.cost).filter((c): c is number => c != null);
    const bestCost = costs.length ? Math.min(...costs) : null;
    const components = {
      activatedShops: bestActivated ? f.activated / bestActivated : 0,
      registrationQuality: f.registered ? (f.registered - f.poor) / f.registered : 0,
      activity30: f.activated ? f.active30 / f.activated : 0,
      // No shop live yet: nothing to measure. Free (₹0) beats any cost.
      costPerActivatedShop: f.cost == null ? 0 : f.cost === 0 ? 1 : bestCost != null ? bestCost / f.cost : 0,
      coverage: f.territoryAreas ? f.withShops / f.territoryAreas : 0,
    };
    const score =
      components.activatedShops * weights.activatedShops +
      components.registrationQuality * weights.registrationQuality +
      components.activity30 * weights.activity30 +
      components.costPerActivatedShop * weights.costPerActivatedShop +
      components.coverage * weights.coverage;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      dealerId: f.d.id,
      dealerName: f.d.legalName,
      isInternal: f.d.isInternal,
      peerGroup: f.peerGroup,
      rank: 0,
      peers: peers.length,
      score: Math.round(score * 10) / 10,
      components: {
        activatedShops: round2(components.activatedShops),
        registrationQuality: round2(components.registrationQuality),
        activity30: round2(components.activity30),
        costPerActivatedShop: round2(components.costPerActivatedShop),
        coverage: round2(components.coverage),
      },
      facts: {
        registered: f.registered,
        activated: f.activated,
        poorRegistrations: f.poor,
        active30: f.active30,
        commissionPaise: f.commission,
        costPerActivatedPaise: f.cost == null ? null : Math.round(f.cost),
        territoryAreas: f.territoryAreas,
        areasWithShops: f.withShops,
      },
    };
  });
  for (const r of rows) r.rank = rows.filter((o) => o.peerGroup === r.peerGroup && o.score > r.score).length + 1;
  rows.sort((a, b) => a.peerGroup.localeCompare(b.peerGroup) || a.rank - b.rank || a.dealerName.localeCompare(b.dealerName));
  return { weights, rows };
}
