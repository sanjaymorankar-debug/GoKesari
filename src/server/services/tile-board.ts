/**
 * Live figures for the Tile Board home screens (customer, shop owner, admin,
 * operator).
 *
 * Everything here is read-only and best-effort: the board is navigation
 * first, so a figure that cannot be read is simply left off its tile — it
 * never takes the screen down and is never replaced by a made-up number.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { RETURN_TERMINAL } from "@/lib/return-states";
import { DISPUTE_TERMINAL } from "@/lib/dispute-states";
import { shortLocationLabel, type CustomerLocation } from "@/lib/location";
import { formatQuantity } from "@/lib/money";
import { isShopOpenNow, shopHoursLabel } from "@/lib/shop-hours";
import { displayShopName } from "@/lib/shop-display";
import { db } from "@/server/db";
import {
  bankAccounts,
  bankRefundRequests,
  deliveryOrders,
  deliveryPartnerChangeRequests,
  deliveryPartners,
  grievances,
  marketingCampaigns,
  orderDisputes,
  orderGroups,
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
  shopProductCategories,
  shopProducts,
  shops,
  societies,
  societyRiders,
  stockAlerts,
  subscriptions,
  users,
  vouchers,
  type Shop,
} from "@/server/db/schema";
import { getCart } from "@/server/services/cart";
import { listOpsExceptions } from "@/server/services/ops-exceptions";
import { listNearbyShops } from "@/server/services/serviceability";
import { getTomorrowDelivery } from "@/server/services/tomorrow-delivery";
import { getWalletByUserId } from "@/server/services/wallet";

/** A figure that could not be read is `undefined`, and its badge is not drawn. */
export type BoardCounts = Record<string, number | undefined>;
/** Yes/no facts behind the green ticks. */
export type BoardFlags = Record<string, boolean | undefined>;

/** Orders the customer is still waiting for / the shop is still working on. */
const ORDER_IN_FLIGHT = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;
const ORDER_PAST = ["DELIVERED", "CANCELLED", "REFUNDED", "RETURNED", "FAILED"] as const;

function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** Gives up on a slow read rather than holding the screen for it. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs one statement of scalar sub-selects and returns its single row as
 * numbers. On any error every figure is `undefined` — tiles then show no badge.
 */
async function readCounts(label: string, columns: Record<string, SQL>): Promise<BoardCounts> {
  const keys = Object.keys(columns);
  if (keys.length === 0) return {};
  const selects = sql.join(
    keys.map((key) => sql`(${columns[key]}) as ${sql.identifier(key)}`),
    sql`, `,
  );
  try {
    const rows = (await db.execute(sql`select ${selects}`)) as unknown as Record<string, unknown>[];
    const row = rows[0] ?? {};
    const out: BoardCounts = {};
    for (const key of keys) {
      const value = Number(row[key]);
      out[key] = Number.isFinite(value) ? value : undefined;
    }
    return out;
  } catch (error) {
    console.error(`[tile-board] ${label} counts failed`, error);
    return {};
  }
}

/* ------------------------------------------------------------------ customer */

export interface CustomerBoardData {
  signedIn: boolean;
  firstName: string | null;
  counts: BoardCounts;
  /** Values for `{name}` placeholders in the menu links. */
  vars: Record<string, string | undefined>;
  walletBalancePaise: number | null;
  locationLabel: string | null;
  /** The order nearest the door, for the banner and the Tracking tile. */
  activeOrder: {
    orderNumber: string;
    status: string;
    riderName: string | null;
    href: string;
  } | null;
  /** Tomorrow's subscription deliveries in one line. */
  tomorrow: {
    what: string;
    more: number;
    costPaise: number;
    cutoffHour: number;
    beforeCutoff: boolean;
    allSkipped: boolean;
  } | null;
  cart: { itemCount: number; totalPaise: number; firstShop: string | null; otherShops: number };
  /** Things this customer bought before that can be added again right now. */
  buyAgain: {
    shopProductId: string;
    name: string;
    quantityLabel: string;
    shopName: string;
    pricePaise: number;
    imageUrl: string | null;
  }[];
  /** Shown beside the tiles when there is no purchase history yet. */
  nearbyShops: { name: string; slug: string; hours: string }[];
  /** A short line of context under each desktop tile. */
  footers: Partial<Record<"shops" | "orders" | "tracking" | "subscriptions" | "wallet" | "profile", string>>;
}

/** The board before (or without) its figures — also what a signed-out visitor sees. */
export function emptyCustomerBoard(signedIn: boolean, location: CustomerLocation | null): CustomerBoardData {
  return {
    signedIn,
    firstName: null,
    counts: {},
    vars: { tomorrowHref: "/subscriptions", subscriptionHref: "/subscriptions" },
    walletBalancePaise: null,
    locationLabel: location ? shortLocationLabel(location) : null,
    activeOrder: null,
    tomorrow: null,
    cart: { itemCount: 0, totalPaise: 0, firstShop: null, otherShops: 0 },
    buyAgain: [],
    nearbyShops: [],
    footers: {},
  };
}

export async function getCustomerBoard(
  user: { id: string; name: string | null } | null,
  location: CustomerLocation | null,
): Promise<CustomerBoardData> {
  const data = emptyCustomerBoard(Boolean(user), location);
  data.firstName = user?.name?.trim().split(/\s+/)[0] ?? null;

  const now = new Date();
  // Shops near the chosen place; without one, the size of the whole directory.
  const nearbyWork = location
    ? within(4000, listNearbyShops(location)).then((list) => {
        if (!list) return;
        data.counts.shopsNearby = list.length;
        data.counts.shopsOpen = list.filter((shop) => isShopOpenNow(shop, now)).length;
        data.counts.shopsDeliver = list.filter((shop) => shop.deliversHere).length;
        data.nearbyShops = list.slice(0, 6).map((shop) => ({
          name: displayShopName(shop.name),
          slug: shop.slug,
          hours: shopHoursLabel(shop, now),
        }));
        const first = data.nearbyShops[0];
        if (first) data.footers.shops = `${first.name} · ${first.hours.toLowerCase()}`;
      })
    : readCounts("directory", {
        shopsNearby: sql`select count(*)::int from ${shops} where ${shops.status} = 'APPROVED' and ${shops.deletedAt} is null`,
      }).then((counts) => Object.assign(data.counts, counts));

  const categoriesWork = readCounts("categories", {
    categories: sql`select count(*)::int from ${shopCategories} where ${shopCategories.status} = 'ACTIVE'`,
  }).then((counts) => Object.assign(data.counts, counts));

  if (!user) {
    await Promise.all([nearbyWork, categoriesWork]);
    return data;
  }

  const countsWork = readCounts("customer", {
    ordersActive: sql`select count(*)::int from ${orders} where ${orders.userId} = ${user.id} and ${orders.status} in (${inList(ORDER_IN_FLIGHT)})`,
    ordersPast: sql`select count(*)::int from ${orders} where ${orders.userId} = ${user.id} and ${orders.status} in (${inList(ORDER_PAST)})`,
    returnsOpen: sql`select count(*)::int from ${returnRequests} where ${returnRequests.userId} = ${user.id} and ${returnRequests.status} not in (${inList(RETURN_TERMINAL)})`,
    subscriptionsActive: sql`select count(*)::int from ${subscriptions} where ${subscriptions.userId} = ${user.id} and ${subscriptions.status} in ('ACTIVE', 'PAYMENT_PENDING', 'RENEWAL_PENDING')`,
  }).then((counts) => Object.assign(data.counts, counts));

  // No wallet row yet is a balance of zero; a failed read shows no balance.
  const walletWork = getWalletByUserId(user.id)
    .then((wallet) => {
      data.walletBalancePaise = wallet?.balancePaise ?? 0;
    })
    .catch(() => {
      data.walletBalancePaise = null;
    });

  const activeOrderWork = within(
    3000,
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        groupReference: orderGroups.reference,
        riderName: deliveryPartners.fullName,
        riderStatus: deliveryOrders.status,
      })
      .from(orders)
      .leftJoin(orderGroups, eq(orders.orderGroupId, orderGroups.id))
      .leftJoin(
        deliveryOrders,
        and(eq(deliveryOrders.orderId, orders.id), inArray(deliveryOrders.status, ["ACCEPTED", "PICKED_UP"])),
      )
      .leftJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
      .where(and(eq(orders.userId, user.id), inArray(orders.status, [...ORDER_IN_FLIGHT])))
      // The order furthest along comes first: it is the one about to arrive.
      .orderBy(
        sql`case ${orders.status} when 'OUT_FOR_DELIVERY' then 0 when 'PICKED_UP' then 1 when 'ASSIGNED' then 2 when 'READY' then 3 when 'PREPARING' then 4 when 'ACCEPTED' then 5 else 6 end`,
        desc(orders.createdAt),
      )
      .limit(1),
  ).then((rows) => {
    const row = rows?.[0];
    if (!row) return;
    data.activeOrder = {
      orderNumber: row.orderNumber,
      status: row.status,
      riderName: row.riderName?.trim().split(/\s+/)[0] ?? null,
      href: row.groupReference ? `/orders/group/${row.groupReference}` : "/orders",
    };
  });

  const tomorrowWork = within(4000, getTomorrowDelivery(user.id)).then((tomorrow) => {
    if (!tomorrow || tomorrow.lines.length === 0) return;
    const live = tomorrow.lines.filter((line) => !line.skipped);
    const shown = live[0] ?? tomorrow.lines[0];
    data.tomorrow = {
      what: `${shown.productName} ${formatQuantity(shown.quantityMilli, shown.unit)}`,
      more: Math.max(live.length - 1, 0),
      costPaise: live.reduce(
        (sum, line) => sum + Math.round(((line.unitPricePaise ?? 0) * line.quantityMilli) / 1000),
        0,
      ),
      cutoffHour: tomorrow.cutoffHour,
      beforeCutoff: tomorrow.beforeCutoff,
      allSkipped: live.length === 0,
    };
    data.vars.tomorrowHref = "/#tomorrow-delivery";
    if (tomorrow.lines.length === 1) data.vars.subscriptionHref = `/subscriptions/${tomorrow.lines[0].subscriptionId}`;
  });

  const cartWork = within(4000, getCart(user.id)).then((cart) => {
    if (!cart) return;
    const groups = cart.groups.filter((group) => group.lines.length > 0);
    data.cart = {
      itemCount: cart.itemCount,
      totalPaise: cart.grandTotalPaise,
      firstShop: groups[0] ? displayShopName(groups[0].shop.name) : null,
      otherShops: Math.max(groups.length - 1, 0),
    };
  });

  const buyAgainWork = within(4000, listBuyAgain(user.id)).then((rows) => {
    if (rows) data.buyAgain = rows;
  });

  await Promise.all([
    nearbyWork,
    categoriesWork,
    countsWork,
    walletWork,
    activeOrderWork,
    tomorrowWork,
    cartWork,
    buyAgainWork,
  ]);

  if (data.activeOrder) data.footers.orders = data.activeOrder.orderNumber;
  if (data.activeOrder?.riderName) data.footers.tracking = data.activeOrder.riderName;
  if (data.tomorrow && !data.tomorrow.allSkipped) data.footers.subscriptions = data.tomorrow.what;
  if (data.locationLabel) data.footers.profile = data.locationLabel;
  return data;
}

/**
 * Up to six things the customer has had delivered before and can buy again
 * right now — most recently bought first, one row per product.
 */
async function listBuyAgain(userId: string): Promise<CustomerBoardData["buyAgain"]> {
  const rows = await db
    .select({
      shopProductId: orderItems.shopProductId,
      name: products.name,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
      shopName: shops.name,
      pricePaise: shopProducts.onlinePricePaise,
      shopImage: shopProducts.imageUrl,
      productImage: products.imageUrl,
      lastBought: sql<string>`max(${orders.createdAt})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(shopProducts, eq(orderItems.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.status, "DELIVERED"),
        eq(orders.orderType, "PERSONAL"),
        eq(shops.status, "APPROVED"),
        eq(shopProducts.isActive, true),
        eq(shopProducts.isAvailable, true),
        eq(shopProducts.onlineSaleEnabled, true),
        sql`${shopProducts.deletedAt} is null`,
        sql`${shopProducts.onlinePricePaise} is not null`,
      ),
    )
    .groupBy(
      orderItems.shopProductId,
      products.name,
      products.unit,
      products.unitSizeMilli,
      shops.name,
      shopProducts.onlinePricePaise,
      shopProducts.imageUrl,
      products.imageUrl,
    )
    .orderBy(sql`max(${orders.createdAt}) desc`)
    .limit(6);

  return rows.map((row) => ({
    shopProductId: row.shopProductId,
    name: row.name,
    quantityLabel: formatQuantity(row.unitSizeMilli && row.unitSizeMilli > 0 ? row.unitSizeMilli : 1000, row.unit),
    shopName: displayShopName(row.shopName),
    pricePaise: row.pricePaise ?? 0,
    imageUrl: row.shopImage ?? row.productImage ?? null,
  }));
}

/* ---------------------------------------------------------------- shop owner */

export interface ShopBoardData {
  shopName: string;
  counts: BoardCounts;
  flags: BoardFlags;
  vars: Record<string, string | undefined>;
}

export async function getShopBoard(
  shop: Pick<Shop, "id" | "name" | "slug" | "status" | "gstStatus" | "panStatus">,
): Promise<ShopBoardData> {
  const id = shop.id;
  const [counts, verification] = await Promise.all([
    readCounts("shop", {
      ordersNew: sql`select count(*)::int from ${orders} where ${orders.shopId} = ${id} and ${orders.status} = 'CONFIRMED'`,
      ordersPacking: sql`select count(*)::int from ${orders} where ${orders.shopId} = ${id} and ${orders.status} in ('ACCEPTED', 'PREPARING')`,
      ordersReady: sql`select count(*)::int from ${orders} where ${orders.shopId} = ${id} and ${orders.status} in ('READY', 'ASSIGNED')`,
      ordersOut: sql`select count(*)::int from ${orders} where ${orders.shopId} = ${id} and ${orders.status} in ('PICKED_UP', 'OUT_FOR_DELIVERY')`,
      returnsOpen: sql`select count(*)::int from ${returnRequests} where ${returnRequests.shopId} = ${id} and ${returnRequests.status} not in (${inList(RETURN_TERMINAL)})`,
      returnsReview: sql`select count(*)::int from ${returnRequests} where ${returnRequests.shopId} = ${id} and ${returnRequests.status} in ('RETURN_REQUESTED', 'UNDER_REVIEW')`,
      returnsPickup: sql`select count(*)::int from ${returnRequests} where ${returnRequests.shopId} = ${id} and ${returnRequests.status} in ('APPROVED', 'PICKUP_ASSIGNED', 'PICKUP_SCHEDULED', 'RIDER_EN_ROUTE')`,
      disputesOpen: sql`select count(*)::int from ${orderDisputes} where ${orderDisputes.shopId} = ${id} and ${orderDisputes.status} not in (${inList(DISPUTE_TERMINAL)})`,
      stockLow: sql`select count(*)::int from ${stockAlerts} where ${stockAlerts.shopId} = ${id} and ${stockAlerts.status} = 'OPEN'`,
      categoriesMine: sql`select count(*)::int from ${shopProductCategories} where ${shopProductCategories.shopId} = ${id}`,
      priceRequests: sql`select count(*)::int from ${priceUpdateRequests} where ${priceUpdateRequests.shopId} = ${id} and ${priceUpdateRequests.status} = 'PENDING'`,
      campaigns: sql`select count(*)::int from ${marketingCampaigns} where ${marketingCampaigns.shopId} = ${id} and ${marketingCampaigns.status} in ('DRAFT', 'SUBMITTED', 'APPROVED')`,
      offersActive: sql`select count(*)::int from ${shopOffers} where ${shopOffers.shopId} = ${id} and ${shopOffers.active} and ${shopOffers.startsAt} <= now() and ${shopOffers.endsAt} > now()`,
      deliveryStaff: sql`select count(*)::int from ${shopDeliveryStaff} where ${shopDeliveryStaff.shopId} = ${id} and ${shopDeliveryStaff.isActive}`,
      legalPending: sql`select count(*)::int from ${shopLegalDocuments} where ${shopLegalDocuments.shopId} = ${id} and ${shopLegalDocuments.status} in ('NOT_SUBMITTED', 'REJECTED')`,
      bankVerified: sql`select count(*)::int from ${bankAccounts} where ${bankAccounts.shopId} = ${id} and ${bankAccounts.status} = 'VERIFIED'`,
    }),
    readCounts("shop verification", {
      docsVerified: sql`select count(*)::int from ${sellerVerifications} where ${sellerVerifications.shopId} = ${id} and ${sellerVerifications.status} = 'VERIFIED'`,
      docsOpen: sql`select count(*)::int from ${sellerVerifications} where ${sellerVerifications.shopId} = ${id} and ${sellerVerifications.status} in ('PENDING', 'FAILED', 'MANUAL_REVIEW', 'EXPIRED')`,
    }),
  ]);

  const openOrders = ["ordersNew", "ordersPacking", "ordersReady", "ordersOut"].map((key) => counts[key]);
  counts.ordersOpen = openOrders.every((n) => n !== undefined)
    ? openOrders.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : undefined;

  const documentsVerified =
    verification.docsVerified !== undefined && verification.docsOpen !== undefined
      ? verification.docsVerified > 0 && verification.docsOpen === 0
      : undefined;

  return {
    shopName: displayShopName(shop.name),
    counts,
    flags: {
      bankVerified: counts.bankVerified === undefined ? undefined : counts.bankVerified > 0,
      // Verified = the documents the checks hold are all verified, or an admin
      // confirmed GST and PAN by hand (the route older registrations took).
      shopVerified:
        documentsVerified === true || (shop.gstStatus === "VERIFIED" && shop.panStatus === "VERIFIED")
          ? true
          : documentsVerified,
    },
    vars: { slug: shop.slug },
  };
}

/* ----------------------------------------------------------- admin, operator */

export interface StaffBoardData {
  counts: BoardCounts;
}

/** Figures the admin and operator screens share. */
function sharedStaffCounts(): Record<string, SQL> {
  return {
    shopsPending: sql`select count(*)::int from ${shops} where ${shops.status} = 'PENDING_APPROVAL' and ${shops.deletedAt} is null`,
    returnsOpen: sql`select count(*)::int from ${returnRequests} where ${returnRequests.status} not in (${inList(RETURN_TERMINAL)})`,
    disputesOpen: sql`select count(*)::int from ${orderDisputes} where ${orderDisputes.status} not in (${inList(DISPUTE_TERMINAL)})`,
    grievancesOpen: sql`select count(*)::int from ${grievances} where ${grievances.status} in ('OPEN', 'IN_PROGRESS')`,
    imagesPending: sql`select count(*)::int from ${productImages} where ${productImages.moderationStatus} = 'PENDING'`,
  };
}

export async function getAdminBoard(): Promise<StaffBoardData> {
  const [queues, totals] = await Promise.all([
    readCounts("admin queues", {
      ...sharedStaffCounts(),
      productsReview: sql`select count(*)::int from ${products} where ${products.approvalStatus} = 'PENDING_APPROVAL' and ${products.deletedAt} is null`,
      refundsPending: sql`select count(*)::int from ${bankRefundRequests} where ${bankRefundRequests.status} in ('REQUESTED', 'PROCESSING')`,
      sellerDocsReview: sql`select count(*)::int from ${sellerVerifications} where ${sellerVerifications.status} = 'MANUAL_REVIEW'`,
      shopsSuspended: sql`select count(*)::int from ${shops} where ${shops.status} = 'SUSPENDED' and ${shops.deletedAt} is null`,
      riskOpen: sql`select count(*)::int from ${riskFlags} where ${riskFlags.status} = 'OPEN'`,
      campaignsSubmitted: sql`select count(*)::int from ${marketingCampaigns} where ${marketingCampaigns.status} = 'SUBMITTED'`,
    }),
    readCounts("admin totals", {
      shopsAll: sql`select count(*)::int from ${shops} where ${shops.deletedAt} is null`,
      usersAll: sql`select count(*)::int from ${users} where ${users.deletedAt} is null`,
      usersCustomers: sql`select count(*)::int from ${users} where ${users.role} = 'CUSTOMER' and ${users.deletedAt} is null`,
      usersOwners: sql`select count(*)::int from ${users} where ${users.role} = 'SHOP_OWNER' and ${users.deletedAt} is null`,
      usersRiders: sql`select count(*)::int from ${deliveryPartners} where ${deliveryPartners.status} = 'APPROVED' and ${deliveryPartners.deletedAt} is null`,
      usersStaff: sql`select count(*)::int from ${users} where ${users.role} in ('ADMIN', 'OPERATOR') and ${users.deletedAt} is null`,
      shopCategories: sql`select count(*)::int from ${shopCategories} where ${shopCategories.status} = 'ACTIVE'`,
      productCategories: sql`select count(*)::int from ${productCategories} where ${productCategories.isActive} and ${productCategories.deletedAt} is null`,
      productsAll: sql`select count(*)::int from ${products} where ${products.deletedAt} is null`,
    }),
  ]);
  return { counts: { ...totals, ...queues } };
}

export async function getOperatorBoard(options: { canViewOrders: boolean }): Promise<StaffBoardData> {
  const [counts, exceptions] = await Promise.all([
    readCounts("operator", {
      ...sharedStaffCounts(),
      legalDocsReview: sql`select count(*)::int from ${shopLegalDocuments} where ${shopLegalDocuments.status} = 'SUBMITTED'`,
      ordersLive: sql`select count(*)::int from ${orders} where ${orders.status} in (${inList(ORDER_IN_FLIGHT)})`,
      ridersOnline: sql`select count(*)::int from ${deliveryPartners} where ${deliveryPartners.isOnline} and ${deliveryPartners.status} = 'APPROVED' and ${deliveryPartners.deletedAt} is null`,
      ridersPending: sql`select count(*)::int from ${deliveryPartners} where ${deliveryPartners.status} in ('REGISTERED', 'UNDER_REVIEW') and ${deliveryPartners.deletedAt} is null`,
      riderChanges: sql`select count(*)::int from ${deliveryPartnerChangeRequests} where ${deliveryPartnerChangeRequests.status} = 'PENDING'`,
      societies: sql`select count(*)::int from ${societies} where ${societies.status} = 'VERIFIED' and ${societies.deletedAt} is null`,
      societiesApplied: sql`select count(*)::int from ${societies} where ${societies.status} = 'APPLIED' and ${societies.deletedAt} is null`,
      societyRiders: sql`select count(*)::int from ${societyRiders} where ${societyRiders.status} = 'ACTIVE'`,
      vouchersActive: sql`select count(*)::int from ${vouchers} where ${vouchers.status} = 'ACTIVE'`,
      disputesEscalated: sql`select count(*)::int from ${orderDisputes} where ${orderDisputes.level} = 'L2' and ${orderDisputes.status} not in (${inList(DISPUTE_TERMINAL)})`,
    }),
    // The exception queue is many queries; never hold the console for it.
    options.canViewOrders ? within(2500, listOpsExceptions()) : Promise.resolve(undefined),
  ]);

  counts.exceptions = exceptions?.summary.total;
  counts.exceptionsCritical = exceptions?.summary.critical;
  counts.ticketsOpen =
    counts.grievancesOpen !== undefined && counts.disputesOpen !== undefined
      ? counts.grievancesOpen + counts.disputesOpen
      : undefined;
  return { counts };
}

/** Local hour (0–23) → "8 PM". */
export function hourLabel(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

