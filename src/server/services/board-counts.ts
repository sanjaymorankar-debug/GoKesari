/**
 * Live figures for the Tile Board home screens (read-only).
 *
 * Best-effort by design: every figure is its own query, time-boxed and
 * caught. A failed or slow query leaves its key out, which the board shows as
 * no badge — it never breaks the page and never shows a stand-in number.
 */
import { cache } from "react";
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";

import type { Counts } from "@/lib/board/menus";
import { DISPUTE_TERMINAL } from "@/lib/dispute-states";
import { serializeLocation, type CustomerLocation } from "@/lib/location";
import { RETURN_TERMINAL } from "@/lib/return-states";
import { isShopOpenNow } from "@/lib/shop-hours";
import { db } from "@/server/db";
import {
  bankAccounts,
  bankRefundRequests,
  deliveryPartnerChangeRequests,
  deliveryPartners,
  deliveryPartnerSessions,
  externalPriceReferences,
  grievances,
  marketingCampaigns,
  mrpCorrections,
  orderDisputes,
  orderItems,
  orders,
  priceUpdateRequests,
  productCategories,
  productImages,
  products,
  returnRequests,
  riskFlags,
  sellerVerifications,
  shopCategories,
  shopDeliveryStaff,
  shopLegalDocuments,
  shopOffers,
  shopProducts,
  shops,
  shopSuspensions,
  societies,
  societyMembers,
  societyRiders,
  stockAlerts,
  subscriptions,
  users,
  voucherRedemptions,
  vouchers,
  walletTransactions,
  type UserRole,
} from "@/server/db/schema";
import { loadPurchasableShopProduct } from "./catalogue";
import { unreadCount } from "./notifications";
import { listOpsExceptions } from "./ops-exceptions";
import { getShopVerificationSummary } from "./seller-verification";
import { listNearbyShops } from "./serviceability";
import { getShopWalletBalance } from "./shop-wallet";
import { searchShops } from "./shops";

/** The exceptions queue is read for both a badge and the operator's banner: once per request. */
const opsQueue = cache(() => listOpsExceptions());

/**
 * A figure slower than this is dropped rather than holding up the page. 8 s
 * covers the first visit after a quiet spell, which opens fresh TLS
 * connections (3-5 s) and may wake a suspended Neon compute; at 4 s those
 * visits lost their badges.
 */
const QUERY_TIMEOUT_MS = 8000;

/** Runs one read; undefined when it fails or takes too long. */
export async function settle<T>(label: string, read: () => Promise<T>, timeoutMs = QUERY_TIMEOUT_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[board] ${label} took over ${timeoutMs}ms — badge dropped`);
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error(`[board] ${label} failed — badge dropped`, error);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs a set of named numeric reads in parallel and keeps the ones that came back. */
async function gather(reads: Partial<Record<keyof Counts, () => Promise<number>>>): Promise<Counts> {
  const entries = await Promise.all(
    Object.entries(reads).map(async ([key, read]) => [key, await settle(key, read!)] as const),
  );
  const out: Counts = {};
  for (const [key, value] of entries) {
    if (typeof value === "number" && Number.isFinite(value)) out[key as keyof Counts] = value;
  }
  return out;
}

const one = async (query: Promise<{ n: number }[]>): Promise<number> => Number((await query)[0]?.n ?? 0);

/** Order states between "placed" and "delivered". */
export const IN_PROGRESS_ORDER = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;
const RETURN_REQUESTS = ["RETURN_REQUESTED", "UNDER_REVIEW"] as const;
const RETURN_PICKUPS = ["APPROVED", "PICKUP_ASSIGNED", "PICKUP_SCHEDULED", "RIDER_EN_ROUTE"] as const;

/* ---------------------------------------------------------------- customer */

/**
 * The three shop figures exactly as /shops computes them: nearby (or the whole
 * directory with no location), open now, and delivering here.
 */
async function customerShopCounts(location: CustomerLocation | null) {
  const nearby = location ? await listNearbyShops(location) : [];
  const nearbyById = new Map(nearby.map((s) => [s.id, s]));
  const found = await searchShops({ ids: location ? [...nearbyById.keys()] : undefined, limit: 100 });
  const now = new Date();
  return {
    nearbyShops: found.length,
    openNowShops: found.filter((s) => isShopOpenNow(s, now)).length,
    deliveringShops: found.filter((s) => (location ? (nearbyById.get(s.id)?.deliversHere ?? false) : s.deliveryAvailable)).length,
  };
}

/**
 * Shop and category figures are the same for everyone at a location, so they
 * are kept for a minute per location and served at once while a newer copy
 * loads in the background. A visitor arriving while the database connection
 * is cold no longer waits up to 8 s (or loses the badges) for figures the
 * previous visitor already had. Only complete results are kept.
 */
const SHARED_FIGURES_MS = 60_000;
const sharedFigures = new Map<string, { at: number; value: Counts }>();
const refreshingFigures = new Map<string, Promise<Counts>>();

function refreshSharedFigures(key: string, location: CustomerLocation | null): Promise<Counts> {
  let pending = refreshingFigures.get(key);
  if (!pending) {
    pending = (async () => {
      const [shops, categories] = await Promise.all([
        settle("customer shops", () => customerShopCounts(location)),
        settle("shopCategories", () => one(db.select({ n: count() }).from(shopCategories).where(eq(shopCategories.status, "ACTIVE")))),
      ]);
      const value: Counts = { ...(shops ?? {}), ...(typeof categories === "number" ? { shopCategories: categories } : {}) };
      if (shops && typeof categories === "number") {
        sharedFigures.set(key, { at: Date.now(), value });
        if (sharedFigures.size > 500) sharedFigures.delete(sharedFigures.keys().next().value!);
      }
      return value;
    })().finally(() => refreshingFigures.delete(key));
    refreshingFigures.set(key, pending);
  }
  return pending;
}

async function sharedCustomerFigures(location: CustomerLocation | null): Promise<Counts> {
  const key = location ? serializeLocation(location) : "all";
  const hit = sharedFigures.get(key);
  if (!hit) return refreshSharedFigures(key, location);
  if (Date.now() - hit.at > SHARED_FIGURES_MS) void refreshSharedFigures(key, location).catch(() => {});
  return hit.value;
}

export async function customerCounts(userId: string | null, location: CustomerLocation | null): Promise<Counts> {
  const shopFigures = sharedCustomerFigures(location);
  const personal = (statuses: readonly string[]) =>
    and(eq(orders.userId, userId!), eq(orders.orderType, "PERSONAL"), inArray(orders.status, statuses as never));
  const [figures, shopsFound] = await Promise.all([
    gather({
      ...(userId
        ? {
            activeOrders: () => one(db.select({ n: count() }).from(orders).where(personal(IN_PROGRESS_ORDER))),
            pastOrders: () => one(db.select({ n: count() }).from(orders).where(personal(["DELIVERED"]))),
            openReturns: () =>
              one(db.select({ n: count() }).from(returnRequests).where(and(eq(returnRequests.userId, userId), notInArray(returnRequests.status, [...RETURN_TERMINAL])))),
            activeSubscriptions: () =>
              one(db.select({ n: count() }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "ACTIVE")))),
            unread: () => unreadCount(userId),
          }
        : {}),
    }),
    shopFigures,
  ]);
  return { ...figures, ...shopsFound };
}

export interface ActiveOrderSummary {
  orderNumber: string;
  status: string;
  shopName: string;
  updatedAt: Date;
}

/** The customer's most recent order still on its way, for the "Track" banner. */
export function getActiveOrder(userId: string): Promise<ActiveOrderSummary | undefined> {
  return settle("active order", async () => {
    const [row] = await db
      .select({ orderNumber: orders.orderNumber, status: orders.status, shopName: shops.name, updatedAt: orders.updatedAt })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(and(eq(orders.userId, userId), eq(orders.orderType, "PERSONAL"), inArray(orders.status, [...IN_PROGRESS_ORDER])))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    return row;
  });
}

/** Latest active subscription, for the Calendar and Pause links. */
export function getFirstActiveSubscriptionId(userId: string): Promise<string | undefined> {
  return settle("subscription id", async () => {
    const [row] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "ACTIVE")))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return row?.id;
  });
}

/** The customer's most recent completed wallet debit, for the wallet tile's footer. */
export function getLastWalletPayment(userId: string): Promise<{ amountPaise: number; createdAt: Date } | undefined> {
  return settle("last payment", async () => {
    const [row] = await db
      .select({ amountPaise: walletTransactions.amountPaise, createdAt: walletTransactions.createdAt })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, userId),
          eq(walletTransactions.status, "COMPLETED"),
          inArray(walletTransactions.type, ["PRODUCT_PURCHASE", "SUBSCRIPTION_DEDUCTION"]),
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(1);
    return row ? { amountPaise: Math.abs(row.amountPaise), createdAt: row.createdAt } : undefined;
  });
}

export interface BuyAgainItem {
  shopProductId: string;
  name: string;
  unit: string;
  shopName: string;
  imageUrl: string | null;
  pricePaise: number;
}

/**
 * Items from the customer's delivered orders that can be bought online right
 * now (the same check the cart applies), most recently ordered first.
 */
export function getBuyAgain(userId: string, limit = 6): Promise<BuyAgainItem[] | undefined> {
  return settle("buy again", async () => {
    const recent = await db
      .select({
        shopProductId: orderItems.shopProductId,
        name: orderItems.productNameSnapshot,
        unit: orderItems.unitSnapshot,
        shopName: shops.name,
        lastAt: sql<Date>`max(${orders.createdAt})`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(and(eq(orders.userId, userId), eq(orders.status, "DELIVERED"), eq(orders.orderType, "PERSONAL")))
      .groupBy(orderItems.shopProductId, orderItems.productNameSnapshot, orderItems.unitSnapshot, shops.name)
      .orderBy(desc(sql`max(${orders.createdAt})`))
      .limit(limit * 3);

    const seen = new Set<string>();
    const out: BuyAgainItem[] = [];
    for (const row of recent) {
      if (out.length >= limit || seen.has(row.shopProductId)) continue;
      seen.add(row.shopProductId);
      const live = await loadPurchasableShopProduct(row.shopProductId, 1).catch(() => null);
      if (!live) continue;
      out.push({
        shopProductId: row.shopProductId,
        name: live.product.name,
        unit: row.unit,
        shopName: row.shopName,
        imageUrl: live.shopProduct.imageUrl ?? live.product.imageUrl ?? null,
        pricePaise: live.unitPricePaise,
      });
    }
    return out;
  }, 10_000);
}

/* -------------------------------------------------------------- shop owner */

export async function shopCounts(shopId: string): Promise<Counts> {
  const byStatus = await settle("shop orders", async () => {
    const rows = await db
      .select({ status: orders.status, n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), inArray(orders.status, [...IN_PROGRESS_ORDER])))
      .groupBy(orders.status);
    return new Map(rows.map((r) => [r.status as string, Number(r.n)]));
  });
  const sum = (statuses: readonly string[]) => (byStatus ? statuses.reduce((n, s) => n + (byStatus.get(s) ?? 0), 0) : undefined);
  const orderFigures: Counts = {};
  if (byStatus) {
    orderFigures.shopActiveOrders = sum(IN_PROGRESS_ORDER);
    orderFigures.shopNew = sum(["CONFIRMED"]);
    orderFigures.shopPacking = sum(["ACCEPTED", "PREPARING"]);
    orderFigures.shopReady = sum(["READY", "ASSIGNED"]);
    orderFigures.shopOut = sum(["PICKED_UP", "OUT_FOR_DELIVERY"]);
  }
  const returnsWhere = (statuses: readonly string[]) =>
    one(db.select({ n: count() }).from(returnRequests).where(and(eq(returnRequests.shopId, shopId), inArray(returnRequests.status, statuses as never))));
  const now = new Date();
  const figures = await gather({
    shopOpenReturns: () =>
      one(db.select({ n: count() }).from(returnRequests).where(and(eq(returnRequests.shopId, shopId), notInArray(returnRequests.status, [...RETURN_TERMINAL])))),
    shopReturnRequests: () => returnsWhere(RETURN_REQUESTS),
    shopReturnPickups: () => returnsWhere(RETURN_PICKUPS),
    shopOpenDisputes: () =>
      one(db.select({ n: count() }).from(orderDisputes).where(and(eq(orderDisputes.shopId, shopId), notInArray(orderDisputes.status, [...DISPUTE_TERMINAL])))),
    shopLowStock: () => one(db.select({ n: count() }).from(stockAlerts).where(and(eq(stockAlerts.shopId, shopId), eq(stockAlerts.status, "OPEN")))),
    shopPendingPhotos: () =>
      one(
        db
          .select({ n: count() })
          .from(productImages)
          .innerJoin(shopProducts, eq(shopProducts.id, productImages.shopProductId))
          .where(and(eq(shopProducts.shopId, shopId), eq(productImages.moderationStatus, "PENDING"))),
      ),
    shopPriceRequests: () =>
      one(db.select({ n: count() }).from(priceUpdateRequests).where(and(eq(priceUpdateRequests.shopId, shopId), eq(priceUpdateRequests.status, "PENDING")))),
    shopActiveOffers: () =>
      one(
        db
          .select({ n: count() })
          .from(shopOffers)
          .where(and(eq(shopOffers.shopId, shopId), eq(shopOffers.active, true), lte(shopOffers.startsAt, now), gt(shopOffers.endsAt, now))),
      ),
    shopRiders: () => one(db.select({ n: count() }).from(shopDeliveryStaff).where(and(eq(shopDeliveryStaff.shopId, shopId), eq(shopDeliveryStaff.isActive, true)))),
  });
  return { ...orderFigures, ...figures };
}

export interface ShopFacts {
  bankVerified?: boolean;
  shopVerified?: boolean;
  walletBalancePaise?: number;
}

/** Verified ticks and the wallet balance: each read on its own, unknown when it fails. */
export async function shopBoardFacts(shopId: string, actor: { id: string; role: UserRole }): Promise<ShopFacts> {
  const [bank, verification, wallet] = await Promise.all([
    settle("bank verified", async () => {
      const [row] = await db
        .select({ status: bankAccounts.status })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.isCurrent, true)))
        .limit(1);
      return row?.status === "VERIFIED";
    }),
    settle("shop verified", async () => (await getShopVerificationSummary(shopId, actor)).complete),
    settle("shop wallet", () => getShopWalletBalance(shopId)),
  ]);
  return { bankVerified: bank, shopVerified: verification, walletBalancePaise: wallet };
}

/* -------------------------------------------------------- admin & operator */

const LIVE_DISPUTE = notInArray(orderDisputes.status, [...DISPUTE_TERMINAL]);

export async function staffCounts(role: "ADMIN" | "OPERATOR"): Promise<Counts> {
  const usersByRole = (roles: string[]) => one(db.select({ n: count() }).from(users).where(inArray(users.role, roles as never)));
  const common = {
    pendingShops: () => one(db.select({ n: count() }).from(shops).where(and(eq(shops.status, "PENDING_APPROVAL"), isNull(shops.deletedAt)))),
    pendingImages: () => one(db.select({ n: count() }).from(productImages).where(eq(productImages.moderationStatus, "PENDING"))),
    liveDisputes: () => one(db.select({ n: count() }).from(orderDisputes).where(LIVE_DISPUTE)),
    openReturnsAll: () => one(db.select({ n: count() }).from(returnRequests).where(notInArray(returnRequests.status, [...RETURN_TERMINAL]))),
    openGrievances: () => one(db.select({ n: count() }).from(grievances).where(inArray(grievances.status, ["OPEN", "IN_PROGRESS"]))),
    liveOrders: () => one(db.select({ n: count() }).from(orders).where(inArray(orders.status, [...IN_PROGRESS_ORDER]))),
    opsExceptions: async () => (await opsQueue()).summary.total,
  } satisfies Partial<Record<keyof Counts, () => Promise<number>>>;

  // Admin and operator boards and menu pages share the same figures: an entry
  // a role may not open is filtered out of its menus, so its count never shows.
  void role;
  return gather({
    ...common,
    allShops: () => one(db.select({ n: count() }).from(shops).where(isNull(shops.deletedAt))),
    sellerReviews: () => one(db.select({ n: count() }).from(sellerVerifications).where(eq(sellerVerifications.status, "MANUAL_REVIEW"))),
    activeSuspensions: () => one(db.select({ n: count() }).from(shopSuspensions).where(eq(shopSuspensions.status, "ACTIVE"))),
    users: () => one(db.select({ n: count() }).from(users)),
    customers: () => usersByRole(["CUSTOMER"]),
    owners: () => usersByRole(["SHOP_OWNER"]),
    staff: () => usersByRole(["OPERATOR", "ADMIN"]),
    riders: () => one(db.select({ n: count() }).from(deliveryPartners).where(eq(deliveryPartners.status, "APPROVED"))),
    shopCategoryCount: () => one(db.select({ n: count() }).from(shopCategories)),
    productCategories: () => one(db.select({ n: count() }).from(productCategories)),
    products: () => one(db.select({ n: count() }).from(products)),
    pendingProducts: () => one(db.select({ n: count() }).from(products).where(eq(products.approvalStatus, "PENDING_APPROVAL"))),
    mrpCorrections: () => one(db.select({ n: count() }).from(mrpCorrections).where(eq(mrpCorrections.status, "PENDING"))),
    refPricesToVerify: () =>
      one(db.select({ n: count() }).from(externalPriceReferences).where(eq(externalPriceReferences.verificationStatus, "UNVERIFIED"))),
    bankRefunds: () => one(db.select({ n: count() }).from(bankRefundRequests).where(eq(bankRefundRequests.status, "REQUESTED"))),
    openRisk: () => one(db.select({ n: count() }).from(riskFlags).where(eq(riskFlags.status, "OPEN"))),
    submittedCampaigns: () => one(db.select({ n: count() }).from(marketingCampaigns).where(eq(marketingCampaigns.status, "SUBMITTED"))),
    legalDocsToReview: () => one(db.select({ n: count() }).from(shopLegalDocuments).where(eq(shopLegalDocuments.status, "SUBMITTED"))),
    ridersOnDuty: () =>
      one(db.select({ n: countDistinct(deliveryPartnerSessions.deliveryPartnerId) }).from(deliveryPartnerSessions).where(isNull(deliveryPartnerSessions.endedAt))),
    riderApplications: () =>
      one(db.select({ n: count() }).from(deliveryPartners).where(inArray(deliveryPartners.status, ["REGISTERED", "UNDER_REVIEW"]))),
    riderChanges: () =>
      one(db.select({ n: count() }).from(deliveryPartnerChangeRequests).where(eq(deliveryPartnerChangeRequests.status, "PENDING"))),
    societies: () => one(db.select({ n: count() }).from(societies)),
    societiesApplied: () => one(db.select({ n: count() }).from(societies).where(eq(societies.status, "APPLIED"))),
    societyMembers: () => one(db.select({ n: count() }).from(societyMembers).where(eq(societyMembers.status, "ACTIVE"))),
    societyRiders: () => one(db.select({ n: count() }).from(societyRiders).where(eq(societyRiders.status, "ACTIVE"))),
    activeVouchers: () => one(db.select({ n: count() }).from(vouchers).where(eq(vouchers.status, "ACTIVE"))),
    voucherRedemptions: () => one(db.select({ n: count() }).from(voucherRedemptions)),
    openDisputes: () => one(db.select({ n: count() }).from(orderDisputes).where(eq(orderDisputes.status, "OPEN"))),
    escalatedDisputes: () => one(db.select({ n: count() }).from(orderDisputes).where(eq(orderDisputes.status, "ESCALATED"))),
  });
}

export interface OperatorAlerts {
  attention?: { total: number; oldestOrderNumber: string | null; oldestMinutes: number | null };
  escalated?: { total: number; latestCase: string | null };
}

/** The two operator banners: orders needing attention, and escalated dispute cases. */
export async function operatorAlerts(): Promise<OperatorAlerts> {
  const [attention, escalated] = await Promise.all([
    settle("ops attention", async () => {
      const queue = await opsQueue();
      const oldest = [...queue.rows].sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime())[0];
      return {
        total: queue.summary.total,
        oldestOrderNumber: oldest?.orderNumber ?? null,
        oldestMinutes: oldest ? Math.max(0, Math.floor((Date.now() - oldest.enteredAt.getTime()) / 60_000)) : null,
      };
    }),
    settle("escalated cases", async () => {
      const rows = await db
        .select({ caseNumber: orderDisputes.caseNumber })
        .from(orderDisputes)
        .where(eq(orderDisputes.status, "ESCALATED"))
        .orderBy(desc(orderDisputes.updatedAt));
      return { total: rows.length, latestCase: rows[0]?.caseNumber ?? null };
    }),
  ]);
  return { attention, escalated };
}
