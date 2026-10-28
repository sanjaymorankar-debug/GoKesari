/**
 * The dealer's performance (docs/dealer-programme, GKS-DB-001): shops by stage,
 * pending registrations, onboarding over days / weeks / months, each
 * employee's results and each area's. One dealer's data only — callers pass
 * the dealer of the signed-in user (or staff pass any dealer).
 *
 * Stages come from the shop's own lifecycle (documents → fee → admin → live);
 * "approved instantly" means the GST/PAN rule approved it (step 4), or the
 * shop self-registered and was approved on its payment.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  dealerAssistedSessions,
  dealerCommissionLedger,
  dealerLeads,
  dealers,
  dealerSalespeople,
  geoAreaPincodes,
  geoAreas,
  shopAttributions,
  shopAutoApprovalLog,
  shops,
} from "@/server/db/schema";

export const STAGE_LABELS: Record<string, string> = {
  KYC_PENDING: "Documents pending",
  PAYMENT_PENDING: "Fee pending",
  VERIFIED: "Waiting for admin approval",
  ACTIVE: "Live",
  PAUSED: "Paused",
  SUSPENDED: "Suspended",
  REJECTED: "Rejected",
  CLOSED: "Closed",
};

export interface DealerShopRow {
  shopId: string;
  name: string;
  area: string;
  district: string | null;
  stage: string;
  stageLabel: string;
  approval: "INSTANT" | "ADMIN" | null;
  employee: string | null;
  source: string;
  matchKind: string;
  attributedAt: Date;
  activatedAt: Date | null;
  commissionPaise: number;
}

export interface PeriodPoint {
  label: string;
  registered: number;
  activated: number;
}

export interface EmployeeRow {
  id: string;
  name: string;
  employeeId: string;
  status: string;
  registered: number;
  activated: number;
  activationRate: number;
  openLeads: number;
  convertedLeads: number;
}

export interface AreaRow {
  areaCode: string;
  areaName: string;
  district: string | null;
  registered: number;
  activated: number;
  pending: number;
}

export interface PendingRegistration {
  kind: "OWNER_CODE" | "SHOP";
  id: string;
  title: string;
  detail: string;
  since: Date;
}

export interface DealerPerformance {
  totals: { registered: number; activated: number; pending: number; instant: number; duplicates: number };
  shops: DealerShopRow[];
  pending: PendingRegistration[];
  daily: PeriodPoint[];
  weekly: PeriodPoint[];
  monthly: PeriodPoint[];
  employees: EmployeeRow[];
  areas: AreaRow[];
}

/** PIN code → the most specific area and its district, from geo_area_pincodes (longest prefix). */
async function pinResolver() {
  const [prefixes, areas] = await Promise.all([db.select().from(geoAreaPincodes), db.select().from(geoAreas)]);
  const byCode = new Map(areas.map((a) => [a.code, a]));
  const districtOf = (code: string): string | null => {
    let cur = byCode.get(code);
    for (let i = 0; cur && i < 6; i++) {
      if (cur.level === "DISTRICT") return cur.name;
      cur = cur.parentCode ? byCode.get(cur.parentCode) : undefined;
    }
    return null;
  };
  const sorted = [...prefixes].sort((a, b) => b.pincodePrefix.length - a.pincodePrefix.length);
  return (pin: string) => {
    const hit = sorted.find((p) => pin.startsWith(p.pincodePrefix) && byCode.get(p.areaCode)?.status === "ACTIVE");
    if (!hit) return { code: `PIN-${pin}`, name: `PIN ${pin}`, district: null };
    const area = byCode.get(hit.areaCode)!;
    return { code: area.code, name: area.name, district: districtOf(area.code) };
  };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
function weekStart(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return dayKey(x);
}
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

function series(keys: string[], shopsList: DealerShopRow[], keyOf: (d: Date) => string, label: (k: string) => string): PeriodPoint[] {
  const reg = new Map<string, number>();
  const act = new Map<string, number>();
  for (const s of shopsList) {
    reg.set(keyOf(s.attributedAt), (reg.get(keyOf(s.attributedAt)) ?? 0) + 1);
    if (s.activatedAt) act.set(keyOf(s.activatedAt), (act.get(keyOf(s.activatedAt)) ?? 0) + 1);
  }
  return keys.map((k) => ({ label: label(k), registered: reg.get(k) ?? 0, activated: act.get(k) ?? 0 }));
}

export async function dealerPerformance(dealerId: string, now = new Date()): Promise<DealerPerformance> {
  const rows = await db
    .select({ a: shopAttributions, shop: shops, employee: dealerSalespeople.name })
    .from(shopAttributions)
    .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, shopAttributions.salespersonId))
    .where(and(eq(shopAttributions.dealerId, dealerId), eq(shopAttributions.status, "ACTIVE")))
    .orderBy(desc(shopAttributions.createdAt))
    .limit(5000);
  const shopIds = rows.map((r) => r.shop.id);
  const [instantRows, commissionRows] = await Promise.all([
    shopIds.length
      ? db.select({ shopId: shopAutoApprovalLog.shopId }).from(shopAutoApprovalLog).where(and(inArray(shopAutoApprovalLog.shopId, shopIds), eq(shopAutoApprovalLog.outcome, "APPROVED")))
      : Promise.resolve([]),
    shopIds.length
      ? db
          .select({ shopId: dealerCommissionLedger.shopId, sum: sql<number>`sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} <> 'REVERSED')::int` })
          .from(dealerCommissionLedger)
          .where(and(eq(dealerCommissionLedger.dealerId, dealerId), inArray(dealerCommissionLedger.shopId, shopIds)))
          .groupBy(dealerCommissionLedger.shopId)
      : Promise.resolve([]),
  ]);
  const instant = new Set(instantRows.map((r) => r.shopId));
  const commission = new Map(commissionRows.map((r) => [r.shopId, r.sum ?? 0]));
  const resolve = await pinResolver();

  const shopRows: DealerShopRow[] = rows.map((r) => {
    const place = resolve(r.shop.pincode);
    const approval = r.shop.status === "APPROVED" || r.shop.status === "SUSPENDED" ? (instant.has(r.shop.id) || r.shop.autoApprovedAt ? "INSTANT" : "ADMIN") : null;
    return {
      shopId: r.shop.id,
      name: r.shop.name,
      area: [r.shop.area, r.shop.city].filter(Boolean).join(", ") || place.name,
      district: place.district,
      stage: r.shop.lifecycleStatus,
      stageLabel: STAGE_LABELS[r.shop.lifecycleStatus] ?? r.shop.lifecycleStatus,
      approval,
      employee: r.employee,
      source: r.a.source,
      matchKind: r.a.matchKind,
      attributedAt: r.a.createdAt,
      activatedAt: r.a.activatedAt,
      commissionPaise: commission.get(r.shop.id) ?? 0,
    };
  });

  // Pending: owners who have not confirmed yet, and shops not yet live.
  const sessions = await db
    .select()
    .from(dealerAssistedSessions)
    .where(and(eq(dealerAssistedSessions.dealerId, dealerId), inArray(dealerAssistedSessions.status, ["OTP_SENT", "OWNER_VERIFIED"]), gte(dealerAssistedSessions.createdAt, new Date(now.getTime() - 7 * 86_400_000))))
    .orderBy(desc(dealerAssistedSessions.createdAt));
  const pending: PendingRegistration[] = [
    ...sessions.map((s) => ({
      kind: "OWNER_CODE" as const,
      id: s.id,
      title: s.ownerName,
      detail: s.status === "OTP_SENT" ? "Waiting for the owner's code" : "Owner confirmed — enter the shop's details",
      since: s.createdAt,
    })),
    ...shopRows
      .filter((s) => ["KYC_PENDING", "PAYMENT_PENDING", "VERIFIED"].includes(s.stage))
      .map((s) => ({ kind: "SHOP" as const, id: s.shopId, title: s.name, detail: s.stageLabel, since: s.attributedAt })),
  ];

  // Periods: the last 14 days, 12 weeks and 12 months.
  const days = Array.from({ length: 14 }, (_, i) => dayKey(new Date(now.getTime() - (13 - i) * 86_400_000)));
  const weeks = Array.from({ length: 12 }, (_, i) => weekStart(new Date(now.getTime() - (11 - i) * 7 * 86_400_000)));
  const months = Array.from({ length: 12 }, (_, i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - i), 1))));

  // Employees.
  const [people, leadCounts] = await Promise.all([
    db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId)).orderBy(dealerSalespeople.name),
    db
      .select({ salespersonId: dealerLeads.salespersonId, status: dealerLeads.status, n: sql<number>`count(*)::int` })
      .from(dealerLeads)
      .where(eq(dealerLeads.dealerId, dealerId))
      .groupBy(dealerLeads.salespersonId, dealerLeads.status),
  ]);
  const byPerson = new Map<string, { registered: number; activated: number }>();
  for (const r of rows) {
    if (!r.a.salespersonId) continue;
    const cur = byPerson.get(r.a.salespersonId) ?? { registered: 0, activated: 0 };
    cur.registered += 1;
    if (r.a.activatedAt) cur.activated += 1;
    byPerson.set(r.a.salespersonId, cur);
  }
  const employees: EmployeeRow[] = people.map((p) => {
    const c = byPerson.get(p.id) ?? { registered: 0, activated: 0 };
    const leadsOf = (st: string) => leadCounts.filter((l) => l.salespersonId === p.id && l.status === st).reduce((s, l) => s + l.n, 0);
    return {
      id: p.id,
      name: p.name,
      employeeId: p.employeeId,
      status: p.status,
      registered: c.registered,
      activated: c.activated,
      activationRate: c.registered ? Math.round((c.activated / c.registered) * 100) : 0,
      openLeads: leadsOf("OPEN"),
      convertedLeads: leadsOf("CONVERTED"),
    };
  });

  // Areas.
  const byArea = new Map<string, AreaRow>();
  for (const r of rows) {
    const place = resolve(r.shop.pincode);
    const cur = byArea.get(place.code) ?? { areaCode: place.code, areaName: place.name, district: place.district, registered: 0, activated: 0, pending: 0 };
    cur.registered += 1;
    if (r.a.activatedAt) cur.activated += 1;
    else if (r.shop.status === "PENDING_APPROVAL") cur.pending += 1;
    byArea.set(place.code, cur);
  }

  return {
    totals: {
      registered: shopRows.length,
      activated: shopRows.filter((s) => s.activatedAt).length,
      pending: pending.length,
      instant: shopRows.filter((s) => s.approval === "INSTANT").length,
      duplicates: shopRows.filter((s) => s.matchKind === "DUPLICATE").length,
    },
    shops: shopRows,
    pending,
    daily: series(days, shopRows, dayKey, (k) => k.slice(5)),
    weekly: series(weeks, shopRows, weekStart, (k) => `wk ${k.slice(5)}`),
    monthly: series(months, shopRows, monthKey, (k) => k),
    employees,
    areas: [...byArea.values()].sort((a, b) => b.registered - a.registered),
  };
}

export interface DealerOverviewRow {
  id: string;
  legalName: string;
  status: string;
  isInternal: boolean;
  rating: number;
  activatedShops: number;
  registeredShops: number;
  earnedPaise: number;
  paidPaise: number;
}

/** Staff: every dealer with rating, shops and commission (the "rating list across dealers"). */
export async function dealersOverview(): Promise<DealerOverviewRow[]> {
  const [list, shopCounts, money] = await Promise.all([
    db.select().from(dealers).orderBy(desc(dealers.rating), dealers.legalName),
    db
      .select({ dealerId: shopAttributions.dealerId, n: sql<number>`count(*)::int` })
      .from(shopAttributions)
      .where(eq(shopAttributions.status, "ACTIVE"))
      .groupBy(shopAttributions.dealerId),
    db
      .select({
        dealerId: dealerCommissionLedger.dealerId,
        earned: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} not in ('REVERSED')), 0)::int`,
        paid: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} = 'PAID'), 0)::int`,
      })
      .from(dealerCommissionLedger)
      .groupBy(dealerCommissionLedger.dealerId),
  ]);
  const shopsOf = new Map(shopCounts.map((r) => [r.dealerId, r.n]));
  const moneyOf = new Map(money.map((r) => [r.dealerId, r]));
  return list.map((d) => ({
    id: d.id,
    legalName: d.legalName,
    status: d.status,
    isInternal: d.isInternal,
    rating: d.rating,
    activatedShops: d.activatedShops,
    registeredShops: shopsOf.get(d.id) ?? 0,
    earnedPaise: moneyOf.get(d.id)?.earned ?? 0,
    paidPaise: moneyOf.get(d.id)?.paid ?? 0,
  }));
}
