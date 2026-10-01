/**
 * Role dashboards — every figure is a live query; nothing here is a fixed or
 * sample number. Two views:
 *
 *   getShopDashboard(shopId)      — what one shop operator runs their day from
 *   getAdminDashboard()           — the marketplace's operational picture
 *
 * "Today" is the calendar day in APP_TIMEZONE, the same convention as the rest
 * of the app.
 */
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { todayIn } from "@/lib/dates";
import { db } from "@/server/db";
import {
  auditLogs,
  deliveryPartners,
  grievances,
  notifications,
  orderFinancials,
  orders,
  returnRequests,
  riderSearches,
  shops,
  shopSuspensions,
  stockAlerts,
} from "@/server/db/schema";
import { RETURN_TERMINAL } from "@/lib/return-states";
import { defaultWindow, getLiveOperations, getMarketplaceKpis } from "./analytics";
import { getInventoryDashboard, listInventory } from "./inventory-alerts";
import { getDeliveryStats } from "./notifications";
import { listOpsExceptions } from "./ops-exceptions";
import { listMrpViolations, listCorrections, mrpVerificationSummary } from "./mrp-governance";
import { countOpenRiskFlags } from "./risk";
import { countShopsByStatus } from "./shops";
import { listActiveSuspensions } from "./shop-suspension";

/** SQL for "this timestamp column falls on today's local date". */
const isToday = (column: unknown) =>
  sql`(${column} AT TIME ZONE ${getEnv().APP_TIMEZONE})::date = ${todayIn(getEnv().APP_TIMEZONE)}::date`;

const ACTIVE = ["ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;

/* ------------------------------------------------------------- shop operator */

export interface ShopDashboard {
  shop: { id: string; name: string; status: string; ordersPaused: boolean; deliveryAvailable: boolean };
  suspension: { reason: string; expectedAction: string; since: Date } | null;
  orders: { today: number; pending: number; active: number; completed: number; cancelled: number };
  revenue: { deliveredGoodsPaise: number; commissionPaise: number; netPayablePaise: number; deliveredOrders: number; placedValuePaise: number };
  returns: { open: number; awaitingReview: number; newToday: number };
  inventory: {
    counts: { totalProducts: number; inStock: number; lowStock: number; outOfStock: number; reorderRequired: number };
    openAlerts: number;
    lowStockProducts: { shopProductId: string; name: string; available: number; reserved: number; threshold: number; status: string }[];
  };
  riders: { waitingForRider: number; offered: number; searching: number; searchStopped: number; assigned: number };
  customerIssues: { openGrievances: number; openReturns: number };
  notifications: { unread: number; recent: { id: string; title: string; body: string; createdAt: Date; read: boolean }[] };
}

export async function getShopDashboard(shopId: string, userId: string): Promise<ShopDashboard | null> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return null;

  const [orderCounts, revenueRows, placedRows] = await Promise.all([
    db
      .select({ status: orders.status, n: sql<number>`count(*)::int`, cancelledWithReason: sql<number>`count(*) filter (where ${orders.cancellationReason} is not null)::int` })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), isToday(orders.createdAt)))
      .groupBy(orders.status),
    db
      .select({
        goods: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint`,
        commission: sql<number>`coalesce(sum(${orderFinancials.commissionPaise}), 0)::bigint`,
        payable: sql<number>`coalesce(sum(${orderFinancials.shopPayablePaise}), 0)::bigint`,
        n: sql<number>`count(*)::int`,
      })
      .from(orderFinancials)
      .where(and(eq(orderFinancials.shopId, shopId), isToday(orderFinancials.deliveredAt))),
    db
      .select({ value: sql<number>`coalesce(sum(${orders.totalPaise}), 0)::bigint` })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), isToday(orders.createdAt), sql`${orders.status} NOT IN ('PENDING','PAYMENT_FAILED','WALLET_INSUFFICIENT')`)),
  ]);
  const byStatus = new Map(orderCounts.map((r) => [r.status as string, r.n]));
  const sumOf = (statuses: readonly string[]) => statuses.reduce((n, s) => n + (byStatus.get(s) ?? 0), 0);
  const todayTotal = orderCounts.reduce((n, r) => n + r.n, 0);
  const cancelledToday = orderCounts
    .filter((r) => r.status === "CANCELLED" || r.status === "REFUNDED")
    .reduce((n, r) => n + (r.status === "CANCELLED" ? r.n : r.cancelledWithReason), 0);

  const openReturnRows = await db
    .select({ status: returnRequests.status, n: sql<number>`count(*)::int`, today: sql<number>`count(*) filter (where ${isToday(returnRequests.createdAt)})::int` })
    .from(returnRequests)
    .where(eq(returnRequests.shopId, shopId))
    .groupBy(returnRequests.status);
  const terminal: readonly string[] = RETURN_TERMINAL;
  const openReturns = openReturnRows.filter((r) => !terminal.includes(r.status)).reduce((n, r) => n + r.n, 0);

  const [inventory, rows, [alertCount]] = await Promise.all([
    getInventoryDashboard(shopId),
    listInventory(shopId),
    db.select({ n: count() }).from(stockAlerts).where(and(eq(stockAlerts.shopId, shopId), eq(stockAlerts.status, "OPEN"))),
  ]);

  // READY orders and how the rider search for them stands.
  const readyOrders = await db
    .select({
      id: orders.id,
      deliveryStatus: sql<string | null>`(select d.status::text from delivery_orders d where d.order_id = ${orders.id})`,
      searchStatus: riderSearches.status,
    })
    .from(orders)
    .leftJoin(riderSearches, eq(riderSearches.orderId, orders.id))
    .where(and(eq(orders.shopId, shopId), inArray(orders.status, ["READY", "ASSIGNED"])));
  const riderCount = (predicate: (r: (typeof readyOrders)[number]) => boolean) => readyOrders.filter(predicate).length;
  const hasActiveDelivery = (r: (typeof readyOrders)[number]) => ["OFFERED", "ACCEPTED", "PICKED_UP"].includes(r.deliveryStatus ?? "");

  const [grievanceRow] = await db
    .select({ n: count() })
    .from(grievances)
    .innerJoin(orders, eq(grievances.orderId, orders.id))
    .where(and(eq(orders.shopId, shopId), inArray(grievances.status, ["OPEN", "IN_PROGRESS"])));

  const [unread] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "IN_APP"), isNull(notifications.readAt)));
  const recent = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "IN_APP")))
    .orderBy(desc(notifications.createdAt))
    .limit(5);

  const [susp] =
    shop.status === "SUSPENDED"
      ? await db.select().from(shopSuspensions).where(and(eq(shopSuspensions.shopId, shopId), eq(shopSuspensions.status, "ACTIVE"))).limit(1)
      : [];

  return {
    shop: { id: shop.id, name: shop.name, status: shop.status, ordersPaused: shop.ordersPaused, deliveryAvailable: shop.deliveryAvailable },
    suspension: susp ? { reason: susp.reason, expectedAction: susp.expectedAction, since: susp.effectiveAt } : null,
    orders: {
      today: todayTotal,
      pending: byStatus.get("CONFIRMED") ?? 0,
      active: sumOf(ACTIVE),
      completed: byStatus.get("DELIVERED") ?? 0,
      cancelled: cancelledToday,
    },
    revenue: {
      deliveredGoodsPaise: Number(revenueRows[0]?.goods ?? 0),
      commissionPaise: Number(revenueRows[0]?.commission ?? 0),
      netPayablePaise: Number(revenueRows[0]?.payable ?? 0),
      deliveredOrders: revenueRows[0]?.n ?? 0,
      placedValuePaise: Number(placedRows[0]?.value ?? 0),
    },
    returns: {
      open: openReturns,
      awaitingReview: openReturnRows.filter((r) => r.status === "UNDER_REVIEW").reduce((n, r) => n + r.n, 0),
      newToday: openReturnRows.reduce((n, r) => n + r.today, 0),
    },
    inventory: {
      counts: inventory,
      openAlerts: alertCount?.n ?? 0,
      lowStockProducts: rows
        .filter((r) => r.status !== "IN_STOCK")
        .sort((a, b) => a.available - b.available)
        .slice(0, 8)
        .map((r) => ({ shopProductId: r.shopProductId, name: r.productName, available: r.available, reserved: r.reserved, threshold: r.thresholds.lowStock, status: r.status })),
    },
    riders: {
      waitingForRider: riderCount((r) => !hasActiveDelivery(r) && r.deliveryStatus !== "DELIVERED"),
      offered: riderCount((r) => r.deliveryStatus === "OFFERED"),
      searching: riderCount((r) => !hasActiveDelivery(r) && r.searchStatus === "SEARCHING"),
      searchStopped: riderCount((r) => !hasActiveDelivery(r) && r.searchStatus === "STOPPED"),
      assigned: riderCount((r) => ["ACCEPTED", "PICKED_UP"].includes(r.deliveryStatus ?? "")),
    },
    customerIssues: { openGrievances: grievanceRow?.n ?? 0, openReturns },
    notifications: {
      unread: unread?.n ?? 0,
      recent: recent.map((n) => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, read: n.readAt != null })),
    },
  };
}

/* --------------------------------------------------------------------- admin */

export interface AdminDashboard {
  today: string;
  shops: { byStatus: Record<string, number>; suspended: { shopName: string; reason: string; since: Date; awaitingReview: number }[] };
  orders: { placed: number; delivered: number; cancelled: number; refunded: number; inFlight: number; gmvPaise: number; placedValuePaise: number };
  riders: { online: number; busy: number; pendingApproval: number; searchesStoppedToday: number };
  returns: { open: number; awaitingReview: number; awaitingPickup: number; awaitingRefund: number };
  refunds: { ordersRefundedToday: number; refundedValueTodayPaise: number; returnRefundsTodayPaise: number };
  exceptions: { total: number; critical: number; dispatchSweepLooksDown: boolean };
  inventory: { openOutOfStock: number; openLowStock: number; shopsWithOutOfStock: number };
  catalogue: { mrpCorrectionsPending: number; mrpUnverified: number; pricesAboveMrp: number; referencesToVerify: number };
  notifications: { sent: number; pending: number; failed: number; dead: number; skipped: number };
  auth: { otpRequested: number; otpVerified: number; otpFailed: number; otpBlocked: number; last24hSince: Date };
  risk: { open: number; high: number };
  kpis: { fillRate: number | null; onTimeRate: number | null; cancellationRate: number | null; refundRate: number | null; repeatRate: number | null };
}

export async function getAdminDashboard(): Promise<AdminDashboard> {
  const today = defaultWindow(1);
  const since = new Date(Date.now() - 24 * 3_600_000);

  const [kpis, live, shopCounts, suspensions, exceptions, notificationStats, mrpSummary, violations, corrections, risk] = await Promise.all([
    getMarketplaceKpis(today),
    getLiveOperations(),
    countShopsByStatus(),
    listActiveSuspensions(),
    listOpsExceptions(),
    getDeliveryStats(24),
    mrpVerificationSummary(),
    listMrpViolations(500),
    listCorrections("PENDING"),
    countOpenRiskFlags(),
  ]);

  const [riderPending] = await db
    .select({ n: count() })
    .from(deliveryPartners)
    .where(and(inArray(deliveryPartners.status, ["REGISTERED", "UNDER_REVIEW"]), isNull(deliveryPartners.deletedAt)));
  const [stopped] = await db
    .select({ n: count() })
    .from(riderSearches)
    .where(and(eq(riderSearches.status, "STOPPED"), isToday(riderSearches.stoppedAt)));

  const returnRows = await db
    .select({ status: returnRequests.status, n: sql<number>`count(*)::int` })
    .from(returnRequests)
    .groupBy(returnRequests.status);
  const rs = new Map(returnRows.map((r) => [r.status as string, r.n]));
  const terminal: readonly string[] = RETURN_TERMINAL;
  const [returnRefunds] = await db
    .select({ paise: sql<number>`coalesce(sum(${returnRequests.refundedPaise}), 0)::bigint` })
    .from(returnRequests)
    .where(and(eq(returnRequests.status, "REFUND_COMPLETED"), isToday(returnRequests.updatedAt)));

  const [alertRows, outShops] = await Promise.all([
    db
      .select({ type: stockAlerts.alertType, n: sql<number>`count(*)::int` })
      .from(stockAlerts)
      .where(eq(stockAlerts.status, "OPEN"))
      .groupBy(stockAlerts.alertType),
    db
      .select({ n: sql<number>`count(distinct ${stockAlerts.shopId})::int` })
      .from(stockAlerts)
      .where(and(eq(stockAlerts.status, "OPEN"), eq(stockAlerts.alertType, "OUT_OF_STOCK"))),
  ]);
  const alertBy = new Map(alertRows.map((r) => [r.type as string, r.n]));

  const [refToVerify] = await db.execute<{ n: number }>(sql`select count(*)::int as n from external_price_references where verification_status = 'UNVERIFIED'`);
  const otpRows = await db
    .select({ action: auditLogs.action, n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(gte(auditLogs.createdAt, since), sql`${auditLogs.action} LIKE 'auth.otp_%'`))
    .groupBy(auditLogs.action);
  const otp = new Map(otpRows.map((r) => [r.action as string, r.n]));

  const awaitingReview = suspensions.map((s) => ({
    shopName: s.shopName,
    reason: s.suspension.reason,
    since: s.suspension.effectiveAt,
    awaitingReview: s.orders.filter((o) => o.outcome === "AWAITING_REVIEW" || o.outcome === "FAILED").length,
  }));

  return {
    today: today.from,
    shops: { byStatus: shopCounts, suspended: awaitingReview },
    orders: {
      placed: kpis.orders.placed,
      delivered: kpis.orders.delivered,
      cancelled: kpis.orders.cancelled,
      refunded: kpis.orders.refunded,
      inFlight: live.inFlight.reduce((n, s) => n + s.count, 0),
      gmvPaise: kpis.gmvTrend.reduce((n, d) => n + d.gmvPaise, 0),
      placedValuePaise: kpis.orders.placedValuePaise,
    },
    riders: { online: live.ridersOnline, busy: live.ridersBusy, pendingApproval: riderPending?.n ?? 0, searchesStoppedToday: stopped?.n ?? 0 },
    returns: {
      open: [...rs.entries()].filter(([s]) => !terminal.includes(s)).reduce((n, [, v]) => n + v, 0),
      awaitingReview: rs.get("UNDER_REVIEW") ?? 0,
      awaitingPickup: (rs.get("APPROVED") ?? 0) + (rs.get("PICKUP_ASSIGNED") ?? 0) + (rs.get("PICKUP_SCHEDULED") ?? 0) + (rs.get("RIDER_EN_ROUTE") ?? 0),
      awaitingRefund: (rs.get("APPROVED_FOR_REFUND") ?? 0) + (rs.get("REFUND_INITIATED") ?? 0),
    },
    refunds: {
      ordersRefundedToday: kpis.orders.refunded,
      refundedValueTodayPaise: kpis.orders.refundedValuePaise,
      returnRefundsTodayPaise: Number(returnRefunds?.paise ?? 0),
    },
    exceptions: {
      total: exceptions.summary.total,
      critical: exceptions.summary.critical,
      dispatchSweepLooksDown: exceptions.health.dispatchSweepLooksDown,
    },
    inventory: {
      openOutOfStock: alertBy.get("OUT_OF_STOCK") ?? 0,
      openLowStock: (alertBy.get("LOW_STOCK") ?? 0) + (alertBy.get("REORDER") ?? 0),
      shopsWithOutOfStock: outShops[0]?.n ?? 0,
    },
    catalogue: {
      mrpCorrectionsPending: corrections.length,
      mrpUnverified: (mrpSummary.UNVERIFIED ?? 0) + (mrpSummary.PENDING_VERIFICATION ?? 0),
      pricesAboveMrp: violations.length,
      referencesToVerify: Number((refToVerify as unknown as { n?: number })?.n ?? 0),
    },
    notifications: notificationStats,
    auth: {
      otpRequested: otp.get("auth.otp_requested") ?? 0,
      otpVerified: otp.get("auth.otp_verified") ?? 0,
      otpFailed: otp.get("auth.otp_failed") ?? 0,
      otpBlocked: otp.get("auth.otp_blocked") ?? 0,
      last24hSince: since,
    },
    risk: { open: risk.HIGH + risk.MEDIUM + risk.LOW, high: risk.HIGH },
    kpis: {
      fillRate: kpis.fillRate,
      onTimeRate: kpis.onTime.rate,
      cancellationRate: kpis.cancellationRate,
      refundRate: kpis.refundRate,
      repeatRate: kpis.customers.repeatRate,
    },
  };
}
