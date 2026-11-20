/**
 * What the franchise screens show (brief §10): the owner's dashboard (only his own areas, shops and money; a
 * co-owner of a zone appears only as a count) and the admin's overview, alerts and reports.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import { ALLOCATION_STATUS_LABELS, daysBetween, formatIst, istDate, istMonth, istMonthBounds, payoutDate, renewalOpen, type AllocationStatus } from "@/lib/franchise";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  franchiseAllocations,
  franchiseBookings,
  franchiseComplianceViolations,
  franchiseNotificationLog,
  franchisePerformanceRatings,
  franchiseShopAttributions,
  franchiseZones,
  orderFinancials,
  shops,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { offerView, otherOwnersInZone, ownerStatusForUser, renewalFeeFor } from "./booking";
import { ownerCodes } from "./codes";
import { franchiseConfig, franchiseNow } from "./config";

const FRANCHISE_TYPES = ["ONE_TIME_FRANCHISE", "RECURRING_BASE", "RECURRING_BONUS"] as const;

export interface OwnerArea {
  id: string;
  zoneId: string;
  zoneName: string;
  slotNo: number;
  status: AllocationStatus;
  statusLabel: string;
  activatedAt: string | null;
  expiresAt: string | null;
  expiresAtIst: string;
  daysLeft: number | null;
  tailEndAtIst: string;
  renewalOpen: boolean;
  renewalFeePaise: number | null;
  otherOwners: number;
  launchOffer: boolean;
  shops: number;
}

/** The owner's franchise page. Null when the user has no dealer account. */
export async function ownerDashboard(userId: string) {
  const status = await ownerStatusForUser(userId);
  const offer = await offerView();
  if (!status.dealer) return { status: { hasDealer: false, missing: status.missing, agreementAccepted: false }, offer, areas: [], bookings: [], shops: [], money: null, codes: [], rating: null, violations: [] };
  const dealer = status.dealer;
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  const rows = await db
    .select({ a: franchiseAllocations, zoneName: franchiseZones.name })
    .from(franchiseAllocations)
    .innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId))
    .where(and(eq(franchiseAllocations.ownerDealerId, dealer.id), isNotNull(franchiseAllocations.activatedAt)))
    .orderBy(desc(franchiseAllocations.activatedAt));
  const shopCounts = new Map(
    (await db.select({ allocationId: franchiseShopAttributions.allocationId, n: sql<number>`count(*)::int` }).from(franchiseShopAttributions).where(eq(franchiseShopAttributions.ownerDealerId, dealer.id)).groupBy(franchiseShopAttributions.allocationId)).map((r) => [r.allocationId, Number(r.n)]),
  );
  const areas: OwnerArea[] = [];
  for (const { a, zoneName } of rows) {
    areas.push({
      id: a.id,
      zoneId: a.zoneId,
      zoneName,
      slotNo: a.slotNo,
      status: a.status,
      statusLabel: ALLOCATION_STATUS_LABELS[a.status],
      activatedAt: a.activatedAt?.toISOString() ?? null,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      expiresAtIst: formatIst(a.expiresAt),
      daysLeft: a.expiresAt ? daysBetween(istDate(now), istDate(a.expiresAt)) : null,
      tailEndAtIst: formatIst(a.tailEndAt),
      renewalOpen: a.status === "ACTIVE" && !!a.expiresAt && renewalOpen(a.expiresAt, now, config.renewalWindowDays),
      renewalFeePaise: renewalFeeFor(a, config),
      otherOwners: await otherOwnersInZone(a.zoneId, dealer.id),
      launchOffer: a.launchOffer,
      shops: shopCounts.get(a.id) ?? 0,
    });
  }
  const bookings = await db.select().from(franchiseBookings).where(eq(franchiseBookings.ownerDealerId, dealer.id)).orderBy(desc(franchiseBookings.createdAt)).limit(20);
  const bookingZones = bookings.length
    ? await db.select({ bookingId: franchiseAllocations.bookingId, zoneId: franchiseAllocations.zoneId, status: franchiseAllocations.status }).from(franchiseAllocations).where(inArray(franchiseAllocations.bookingId, bookings.map((b) => b.id)))
    : [];
  const shopRows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, zoneId: franchiseShopAttributions.zoneId, attribution: franchiseShopAttributions.status, registeredAt: franchiseShopAttributions.registeredAt, activatedAt: franchiseShopAttributions.activatedAt })
    .from(franchiseShopAttributions)
    .innerJoin(shops, eq(shops.id, franchiseShopAttributions.shopId))
    .where(eq(franchiseShopAttributions.ownerDealerId, dealer.id))
    .orderBy(desc(franchiseShopAttributions.registeredAt))
    .limit(500);
  // Money: this month's commission so far (estimate), year to date (financial year), next payout.
  const month = istMonth(now);
  const { start } = istMonthBounds(month);
  const [mtd] = (await db.execute(sql`
    select coalesce(sum(o.commission_paise), 0)::bigint as commission, coalesce(sum(o.goods_paise), 0)::bigint as gmv
    from ${orderFinancials} o join ${franchiseShopAttributions} fa on fa.shop_id = o.shop_id
    where fa.owner_dealer_id = ${dealer.id} and fa.status = 'ACTIVE' and o.delivered_at >= ${start.toISOString()}::timestamptz
  `)) as unknown as { commission: string | number; gmv: string | number }[];
  const [rating] = await db.select().from(franchisePerformanceRatings).where(eq(franchisePerformanceRatings.ownerDealerId, dealer.id)).orderBy(desc(franchisePerformanceRatings.month)).limit(1);
  const bonusBp = Math.min(config.bonusMaxBp, rating?.bonusBp ?? 0);
  const commission = Number(mtd?.commission ?? 0);
  const fyStart = (() => {
    const d = istDate(now);
    const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);
    return `${y}-04-01`;
  })();
  const ledger = await db
    .select({ type: dealerCommissionLedger.entryType, status: dealerCommissionLedger.status, amount: sql<number>`sum(${dealerCommissionLedger.amountPaise})::bigint` })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.dealerId, dealer.id), inArray(dealerCommissionLedger.entryType, [...FRANCHISE_TYPES]), gte(dealerCommissionLedger.createdAt, new Date(`${fyStart}T00:00:00+05:30`))))
    .groupBy(dealerCommissionLedger.entryType, dealerCommissionLedger.status);
  const sum = (pred: (r: (typeof ledger)[number]) => boolean) => ledger.filter(pred).reduce((s, r) => s + Number(r.amount), 0);
  const nextPayoutMonth = istDate(now).slice(8, 10) > "05" ? nextMonth(month) : month;
  const violations = await db.select().from(franchiseComplianceViolations).where(eq(franchiseComplianceViolations.ownerDealerId, dealer.id)).orderBy(desc(franchiseComplianceViolations.createdAt));
  return {
    status: { hasDealer: true, dealerName: dealer.legalName, dealerStatus: dealer.status, missing: status.missing, agreementAccepted: status.agreementAccepted },
    offer,
    areas,
    bookings: bookings.map((b) => ({
      id: b.id,
      kind: b.kind,
      status: b.status,
      zones: bookingZones.filter((z) => z.bookingId === b.id).map((z) => z.zoneId),
      totalPaise: b.totalPaise,
      gstPaise: b.gstPaise,
      basePaise: b.basePaise,
      holdExpiresAt: b.holdExpiresAt.toISOString(),
      paidAtIst: formatIst(b.paidAt),
      createdAtIst: formatIst(b.createdAt),
      failureReason: b.failureReason,
    })),
    shops: shopRows.map((s) => ({ ...s, registeredAtIst: formatIst(s.registeredAt), activatedAtIst: formatIst(s.activatedAt) })),
    money: {
      monthLabel: month,
      monthGmvPaise: Number(mtd?.gmv ?? 0),
      monthGoKesariCommissionPaise: commission,
      monthEstimatePaise: Math.round((commission * (config.recurringBaseBp + bonusBp)) / 10_000),
      shareBp: config.recurringBaseBp,
      bonusBp,
      ytdOneTimePaise: sum((r) => r.type === "ONE_TIME_FRANCHISE" && r.status !== "REVERSED"),
      ytdRecurringPaise: sum((r) => r.type !== "ONE_TIME_FRANCHISE" && r.status !== "REVERSED"),
      ytdPaidPaise: sum((r) => r.status === "PAID"),
      nextPayoutDate: payoutDate(nextPayoutMonth, 5, config.bankHolidays, config.payoutOnNextWorkingDay),
    },
    codes: await ownerCodes(dealer.id),
    rating: rating ? { month: rating.month, score: rating.score, bonusBp: rating.bonusBp, explanation: rating.explanation } : null,
    violations: violations.map((v) => ({ level: v.level, note: v.note, atIst: formatIst(v.createdAt) })),
  };
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/* ============================================================= admin */

export interface AdminAllocationRow {
  id: string;
  zoneId: string;
  zoneName: string;
  slotNo: number;
  status: AllocationStatus;
  ownerDealerId: string;
  ownerName: string;
  activatedAtIst: string;
  expiresAtIst: string;
  expiresAt: string | null;
  daysLeft: number | null;
  tailEndAtIst: string;
  feePaise: number;
  launchOffer: boolean;
  launchSeq: number | null;
  renewals: number;
  isTest: boolean;
  bookingId: string;
}

export async function adminAllocations(filter: { zoneId?: string; status?: string } = {}): Promise<AdminAllocationRow[]> {
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  const rows = await db
    .select({ a: franchiseAllocations, zoneName: franchiseZones.name, ownerName: dealers.legalName })
    .from(franchiseAllocations)
    .innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId))
    .innerJoin(dealers, eq(dealers.id, franchiseAllocations.ownerDealerId))
    .where(and(filter.zoneId ? eq(franchiseAllocations.zoneId, filter.zoneId) : undefined, filter.status ? eq(franchiseAllocations.status, filter.status as AllocationStatus) : undefined))
    .orderBy(desc(franchiseAllocations.createdAt))
    .limit(1000);
  return rows.map(({ a, zoneName, ownerName }) => ({
    id: a.id,
    zoneId: a.zoneId,
    zoneName,
    slotNo: a.slotNo,
    status: a.status,
    ownerDealerId: a.ownerDealerId,
    ownerName,
    activatedAtIst: formatIst(a.activatedAt),
    expiresAtIst: formatIst(a.expiresAt),
    expiresAt: a.expiresAt?.toISOString() ?? null,
    daysLeft: a.expiresAt ? daysBetween(istDate(now), istDate(a.expiresAt)) : null,
    tailEndAtIst: formatIst(a.tailEndAt),
    feePaise: a.feePaise,
    launchOffer: a.launchOffer,
    launchSeq: a.launchSeq,
    renewals: a.renewalCount,
    isTest: a.isTest,
    bookingId: a.bookingId,
  }));
}

/** Brief §9.2: every area due in the next 30 days (red at 7 days or fewer), and recent expiries. */
export async function expiringAreas() {
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  const all = await adminAllocations();
  const soon = all.filter((r) => (r.status === "ACTIVE" || r.status === "SUSPENDED") && r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= 30).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  const renewing = new Set(
    (await db.select({ id: franchiseBookings.renewalAllocationId }).from(franchiseBookings).where(and(eq(franchiseBookings.kind, "RENEWAL"), inArray(franchiseBookings.status, ["RESERVED", "PAYMENT_PENDING"])))).map((r) => r.id),
  );
  const expired = all.filter((r) => r.status === "EXPIRED" && r.expiresAt && now.getTime() - new Date(r.expiresAt).getTime() < 30 * 86_400_000);
  const alerts = await db.select().from(franchiseNotificationLog).where(and(eq(franchiseNotificationLog.channel, "ADMIN_ALERT"), gte(franchiseNotificationLog.sentAt, new Date(now.getTime() - 30 * 86_400_000)))).orderBy(desc(franchiseNotificationLog.sentAt)).limit(100);
  return {
    soon: soon.map((r) => ({ ...r, red: (r.daysLeft ?? 99) <= 7, renewal: renewing.has(r.id) ? "payment started" : "not renewed" })),
    expired,
    alerts: alerts.map((a) => ({ kind: a.kind, detail: a.detail, atIst: formatIst(a.sentAt) })),
  };
}

export async function notificationLog(limit = 200) {
  const rows = await db.select().from(franchiseNotificationLog).orderBy(desc(franchiseNotificationLog.sentAt)).limit(limit);
  return rows.map((r) => ({ ...r, sentAtIst: formatIst(r.sentAt) }));
}

/** Held / disputed attributions waiting for an admin (brief §7). */
export async function attributionQueue() {
  return db
    .select({ shopId: franchiseShopAttributions.shopId, shopName: shops.name, zoneId: franchiseShopAttributions.zoneId, ownerName: dealers.legalName, status: franchiseShopAttributions.status, reason: franchiseShopAttributions.holdReason, registeredAt: franchiseShopAttributions.registeredAt })
    .from(franchiseShopAttributions)
    .innerJoin(shops, eq(shops.id, franchiseShopAttributions.shopId))
    .innerJoin(dealers, eq(dealers.id, franchiseShopAttributions.ownerDealerId))
    .where(eq(franchiseShopAttributions.status, "HELD"))
    .orderBy(franchiseShopAttributions.registeredAt);
}

/** Reports (brief §10): fees, occupancy by cluster, shops by owner, commission payable / paid. CSV-ready rows. */
export async function franchiseReport(kind: "fees" | "occupancy" | "owners" | "commission"): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  if (kind === "fees") {
    const rows = await db
      .select({ id: franchiseBookings.id, kind: franchiseBookings.kind, owner: dealers.legalName, areas: franchiseBookings.areaCount, base: franchiseBookings.basePaise, gst: franchiseBookings.gstPaise, total: franchiseBookings.totalPaise, paidAt: franchiseBookings.paidAt, launch: franchiseBookings.launchOffer, test: franchiseBookings.isTest })
      .from(franchiseBookings)
      .innerJoin(dealers, eq(dealers.id, franchiseBookings.ownerDealerId))
      .where(eq(franchiseBookings.status, "PAID"))
      .orderBy(franchiseBookings.paidAt);
    return { columns: ["Booking", "Kind", "Owner", "Areas", "Fee (₹)", "GST (₹)", "Total (₹)", "Paid at (IST)", "Launch offer", "Test"], rows: rows.map((r) => [r.id, r.kind, r.owner, r.areas, r.base / 100, r.gst / 100, r.total / 100, formatIst(r.paidAt), r.launch ? "yes" : "no", r.test ? "yes" : "no"]) };
  }
  if (kind === "occupancy") {
    const { zoneViews, clusterSummary, listClusters } = await import("./zones");
    const zones = await zoneViews();
    const { clusters, total } = clusterSummary(zones, await listClusters());
    const occ = (code: string) => zones.filter((z) => z.clusterCode === code).reduce((s, z) => s + z.occupied, 0);
    return {
      columns: ["Cluster", "Zones", "Bookable zones", "Slots occupied", "Slots free", "Est. shops", "Est. annual area business (₹ Cr)"],
      rows: [...clusters, total].map((c) => [`${c.code} ${c.name}`, c.zones, c.bookable, c.code === "PMR" ? zones.reduce((s, z) => s + z.occupied, 0) : occ(c.code), c.slotsFree, c.estShops, c.annualCrHundredths / 100]),
    };
  }
  if (kind === "owners") {
    const rows = (await db.execute(sql`
      select d.legal_name as owner,
        (select count(*) from franchise_allocations a where a.owner_dealer_id = d.id and a.status = 'ACTIVE')::int as active_areas,
        (select count(*) from franchise_shop_attributions fa where fa.owner_dealer_id = d.id)::int as shops,
        (select count(*) from franchise_shop_attributions fa where fa.owner_dealer_id = d.id and fa.activated_at is not null)::int as activated,
        (select coalesce(sum(o.goods_paise), 0) from order_financials o join franchise_shop_attributions fa on fa.shop_id = o.shop_id where fa.owner_dealer_id = d.id)::bigint as gmv,
        (select coalesce(sum(o.commission_paise), 0) from order_financials o join franchise_shop_attributions fa on fa.shop_id = o.shop_id where fa.owner_dealer_id = d.id)::bigint as gk_commission
      from dealers d where exists (select 1 from franchise_allocations a where a.owner_dealer_id = d.id and a.activated_at is not null and not a.is_test)
      order by 1`)) as unknown as { owner: string; active_areas: number; shops: number; activated: number; gmv: string; gk_commission: string }[];
    return {
      columns: ["Owner", "Active areas", "Shops registered", "Shops activated", "Activation rate %", "Attributed GMV (₹)", "GoKesari commission (₹)"],
      rows: rows.map((r) => [r.owner, r.active_areas, r.shops, r.activated, r.shops ? Math.round((r.activated / r.shops) * 1000) / 10 : 0, Number(r.gmv) / 100, Number(r.gk_commission) / 100]),
    };
  }
  const rows = await db
    .select({ owner: dealers.legalName, type: dealerCommissionLedger.entryType, status: dealerCommissionLedger.status, amount: sql<number>`sum(${dealerCommissionLedger.amountPaise})::bigint`, n: sql<number>`count(*)::int` })
    .from(dealerCommissionLedger)
    .innerJoin(dealers, eq(dealers.id, dealerCommissionLedger.dealerId))
    .where(inArray(dealerCommissionLedger.entryType, [...FRANCHISE_TYPES]))
    .groupBy(dealers.legalName, dealerCommissionLedger.entryType, dealerCommissionLedger.status)
    .orderBy(dealers.legalName);
  return { columns: ["Owner", "Type", "Status", "Entries", "Amount (₹)"], rows: rows.map((r) => [r.owner, r.type, r.status, Number(r.n), Number(r.amount) / 100]) };
}

export function toCsv(report: { columns: string[]; rows: (string | number)[][] }): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [report.columns.map(esc).join(","), ...report.rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
}

/** Brief §3.3: warning → recorded → suspension or termination, each logged; suspension / termination act on every active area. */
export async function recordViolation(input: { ownerDealerId: string; level: "WARNING" | "RECORDED" | "SUSPENSION" | "TERMINATION"; note: string; allocationId?: string | null }, actor: { id: string; role: UserRole }): Promise<void> {
  if (actor.role !== "ADMIN") throw new Error("Only an admin can record a violation.");
  if (input.note.trim().length < 5) throw new Error("Describe the violation (at least 5 characters).");
  await db.transaction(async (tx) => {
    await tx.insert(franchiseComplianceViolations).values({ ownerDealerId: input.ownerDealerId, allocationId: input.allocationId ?? null, level: input.level, note: input.note.trim().slice(0, 1000), createdBy: actor.id });
    if (input.level === "SUSPENSION" || input.level === "TERMINATION") {
      const to = input.level === "SUSPENSION" ? "SUSPENDED" : "TERMINATED";
      const now = new Date();
      await tx
        .update(franchiseAllocations)
        .set({ status: to, updatedAt: now, ...(to === "TERMINATED" ? { endedAt: now, endReason: input.note.slice(0, 300), tailEndAt: now } : {}) })
        .where(and(eq(franchiseAllocations.ownerDealerId, input.ownerDealerId), input.allocationId ? eq(franchiseAllocations.id, input.allocationId) : undefined, inArray(franchiseAllocations.status, to === "SUSPENDED" ? ["ACTIVE"] : ["ACTIVE", "SUSPENDED"])));
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_VIOLATION_RECORDED, entityType: "dealer", entityId: input.ownerDealerId, newValue: input }, tx);
  });
}

