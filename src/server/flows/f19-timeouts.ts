/**
 * Flow spec v3 F19, order timeouts (docs/flows-v3/wave2.md; flag flow_f19; values in rule orderFlowsV3).
 *
 *   - A shop that let an order time out: the customer is pointed to the nearest live shop that lists every item
 *     of the order (suggestAnotherShop). The cancellation and full refund are the existing timeout path.
 *   - No rider: once the rider search has stopped (time / attempts / delivery window) and the shop has not
 *     switched the order to its own delivery or pickup within noRiderCancelAfterMinutes, the order is cancelled by
 *     the system with a full refund (the existing cancel path).
 *   - Pickup not collected: pickupGraceMinutes after the pickup slot ends, the shop is told once and may cancel the
 *     order as not collected (the shop's cancel: full refund — the after-packing charge is ₹0).
 *
 * Every step runs after commit of its own work and never throws out of the sweep.
 */
import { and, eq, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";

import { haversineDistanceKm } from "@/lib/geo/haversine";
import { AppError, conflict, forbidden, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import {
  orderFulfilmentArrangements,
  orderItems,
  orders,
  riderSearches,
  shopProducts,
  shops,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { cancelOrder } from "@/server/services/orders";
import { flowOn, flowsV3Rule } from "./wave2-rules";

interface Actor {
  id: string;
  role: UserRole;
}

export const NO_RIDER_CANCEL_REASON = "No delivery partner was available and the shop did not switch to its own delivery or pickup";
export const PICKUP_NOT_COLLECTED_REASON = "Not collected: the customer did not pick up the order in time";

/* ----------------------------------------------------- another nearby shop */

export interface AlternativeShop {
  shopId: string;
  name: string;
  slug: string;
  distanceKm: number | null;
}

function coords(lat: string | null | undefined, lng: string | null | undefined): { latitude: number; longitude: number } | null {
  const latitude = lat != null ? Number(lat) : NaN;
  const longitude = lng != null ? Number(lng) : NaN;
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

/**
 * The nearest live shop (not the order's own) that sells every product of the order online with stock, within
 * orderFlowsV3.suggestRadiusKm of the delivery address (same pincode when either side has no coordinates).
 */
export async function findAlternativeShop(orderId: string): Promise<AlternativeShop | null> {
  const [order] = await db
    .select({ id: orders.id, shopId: orders.shopId, snapshot: orders.deliveryAddressSnapshot })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return null;
  const lines = await db
    .select({ productId: shopProducts.productId })
    .from(orderItems)
    .innerJoin(shopProducts, eq(shopProducts.id, orderItems.shopProductId))
    .where(and(eq(orderItems.orderId, orderId), ne(orderItems.fulfilmentStatus, "REMOVED")));
  const productIds = [...new Set(lines.map((l) => l.productId))];
  if (productIds.length === 0) return null;
  const [ownShop] = await db.select({ pincode: shops.pincode, lat: shops.latitude, lng: shops.longitude }).from(shops).where(eq(shops.id, order.shopId));
  const target = coords(order.snapshot?.latitude, order.snapshot?.longitude) ?? coords(ownShop?.lat, ownShop?.lng);
  const pincode = order.snapshot?.pincode ?? ownShop?.pincode ?? null;

  const candidates = await db
    .select({ id: shops.id, name: shops.name, slug: shops.slug, pincode: shops.pincode, lat: shops.latitude, lng: shops.longitude })
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        eq(shops.ordersPaused, false),
        ne(shops.id, order.shopId),
        sql`(SELECT count(DISTINCT sp.product_id) FROM ${shopProducts} sp
              WHERE sp.shop_id = ${shops.id} AND sp.deleted_at IS NULL AND sp.online_sale_enabled
                AND sp.is_available AND NOT sp.owner_paused AND (NOT sp.track_inventory OR sp.online_stock > 0)
                AND sp.product_id IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})) = ${productIds.length}`,
      ),
    )
    .limit(200);
  const { suggestRadiusKm } = await flowsV3Rule();
  const ranked = candidates
    .map((c) => {
      const at = coords(c.lat, c.lng);
      const distanceKm = target && at ? haversineDistanceKm(target, at) : null;
      return { shopId: c.id, name: c.name, slug: c.slug, distanceKm, samePincode: c.pincode === pincode };
    })
    .filter((c) => (c.distanceKm != null ? c.distanceKm <= suggestRadiusKm : c.samePincode))
    .sort((a, b) => (a.distanceKm ?? suggestRadiusKm) - (b.distanceKm ?? suggestRadiusKm));
  const best = ranked[0];
  return best ? { shopId: best.shopId, name: best.name, slug: best.slug, distanceKm: best.distanceKm } : null;
}

/** After a timeout cancel (flag flow_f19, suggestAnotherShop): tells the customer about a nearby shop. Never throws. */
export async function suggestAlternativeShopAfterTimeout(orderId: string): Promise<AlternativeShop | null> {
  try {
    if (!(await flowOn("flow_f19")) || !(await flowsV3Rule()).suggestAnotherShop) return null;
    const alternative = await findAlternativeShop(orderId);
    if (!alternative) return null;
    const [order] = await db.select({ userId: orders.userId, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
    if (!order) return null;
    await notify({
      userId: order.userId,
      type: NOTIFICATION_TYPES.ORDER_ALTERNATIVE_SHOP,
      title: "Another shop nearby has your items",
      body: `Order ${order.orderNumber} was cancelled and refunded because the shop did not accept it in time. ${alternative.name}${
        alternative.distanceKm != null ? ` (${alternative.distanceKm.toFixed(1)} km away)` : ""
      } has the same items.`,
      actionUrl: `/shops/${alternative.slug}`,
      metadata: { orderId, alternativeShopId: alternative.shopId },
      dedupeKey: `flows-v3:alternative-shop:${orderId}`,
    });
    return alternative;
  } catch (error) {
    console.error("[flows-v3] alternative shop suggestion failed", orderId, error);
    return null;
  }
}

/* ---------------------------------------------------------------- no rider */

/** Rider searches that ended without a rider for these reasons lead to the cancel (not a shop's own stop). */
const NO_RIDER_REASONS = ["TIME_LIMIT", "RETRY_LIMIT", "WINDOW_EXPIRED"] as const;

export async function runNoRiderCancellations(now: Date = new Date()): Promise<{ cancelled: number; skipped: number }> {
  const result = { cancelled: 0, skipped: 0 };
  if (!(await flowOn("flow_f19"))) return result;
  const { noRiderCancelAfterMinutes } = await flowsV3Rule();
  if (!noRiderCancelAfterMinutes) return result;
  const cutoff = new Date(now.getTime() - noRiderCancelAfterMinutes * 60_000);
  const due = await db
    .select({ orderId: orders.id, shopId: orders.shopId, orderNumber: orders.orderNumber, ownerId: shops.ownerId })
    .from(riderSearches)
    .innerJoin(orders, eq(orders.id, riderSearches.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(riderSearches.status, "STOPPED"),
        inArray(riderSearches.stopReason, [...NO_RIDER_REASONS]),
        lt(riderSearches.stoppedAt, cutoff),
        eq(orders.status, "READY"),
        // The shop switched to its own delivery or pickup: it carries on.
        sql`NOT EXISTS (SELECT 1 FROM ${orderFulfilmentArrangements} a WHERE a.order_id = ${orders.id} AND a.option <> 'GOKESARI_PARTNER')`,
      ),
    )
    .limit(100);
  for (const row of due) {
    try {
      await cancelOrder(row.orderId, null, NO_RIDER_CANCEL_REASON, { onlyIfStatus: "READY" });
    } catch (error) {
      if (error instanceof AppError && (error.code === "CONFLICT" || error.code === "INVALID_STATE_TRANSITION")) {
        result.skipped += 1;
        continue;
      }
      console.error("[flows-v3] no-rider cancel failed", row.orderId, error);
      result.skipped += 1;
      continue;
    }
    await notify({
      userId: row.ownerId,
      type: NOTIFICATION_TYPES.SHOP_ORDER_NO_RIDER_CANCELLED,
      title: "Order cancelled — no delivery partner",
      body: `Order ${row.orderNumber} was cancelled and the customer refunded: no delivery partner accepted it and it was not switched to your own delivery or pickup.`,
      actionUrl: "/shop/orders",
      dedupeKey: `flows-v3:no-rider:${row.orderId}`,
    });
    result.cancelled += 1;
  }
  return result;
}

/* ------------------------------------------------------ pickup not collected */

export interface PickupNoShowState {
  /** The shop may cancel the order as not collected now. */
  cancellable: boolean;
  /** When it becomes cancellable (slot end + grace); null when the order is not a pending pickup. */
  cancellableFrom: Date | null;
}

export async function pickupNoShowState(orderId: string, now: Date = new Date()): Promise<PickupNoShowState> {
  const none = { cancellable: false, cancellableFrom: null };
  if (!(await flowOn("flow_f19"))) return none;
  const [row] = await db
    .select({ status: orders.status, option: orderFulfilmentArrangements.option, end: orderFulfilmentArrangements.scheduledEnd, completedAt: orderFulfilmentArrangements.completedAt })
    .from(orders)
    .innerJoin(orderFulfilmentArrangements, eq(orderFulfilmentArrangements.orderId, orders.id))
    .where(eq(orders.id, orderId));
  if (!row || row.option !== "PICKUP" || row.completedAt || row.status !== "READY") return none;
  const { pickupGraceMinutes } = await flowsV3Rule();
  const from = new Date(row.end.getTime() + pickupGraceMinutes * 60_000);
  return { cancellable: now.getTime() >= from.getTime(), cancellableFrom: from };
}

/** The shop (owner, its staff or operations) cancels a pickup that was not collected in time: full refund. */
export async function cancelUncollectedPickup(orderId: string, actor: Actor, now: Date = new Date(), options: { shopStaff?: boolean } = {}) {
  if (!(await flowOn("flow_f19"))) throw notFound("Order");
  const [order] = await db.select({ shopId: orders.shopId, ownerId: shops.ownerId }).from(orders).innerJoin(shops, eq(shops.id, orders.shopId)).where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
  if (order.ownerId !== actor.id && !options.shopStaff && !can(actor.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY)) {
    throw forbidden("Only the shop can cancel this order.");
  }
  const state = await pickupNoShowState(orderId, now);
  if (!state.cancellable) {
    throw conflict(
      state.cancellableFrom
        ? `The customer can still collect this order. It can be cancelled as not collected from ${state.cancellableFrom.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}.`
        : "This order is not a pickup waiting to be collected.",
    );
  }
  return cancelOrder(orderId, actor, PICKUP_NOT_COLLECTED_REASON, { onlyIfStatus: "READY" });
}

/** Tells the shop once when a pickup was not collected within the grace (the sweep). */
export async function remindUncollectedPickups(now: Date = new Date()): Promise<number> {
  if (!(await flowOn("flow_f19"))) return 0;
  const { pickupGraceMinutes } = await flowsV3Rule();
  const due = await db
    .select({ orderId: orders.id, orderNumber: orders.orderNumber, ownerId: shops.ownerId })
    .from(orderFulfilmentArrangements)
    .innerJoin(orders, eq(orders.id, orderFulfilmentArrangements.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(orderFulfilmentArrangements.option, "PICKUP"),
        isNull(orderFulfilmentArrangements.completedAt),
        eq(orders.status, "READY"),
        sql`${orderFulfilmentArrangements.scheduledEnd} + make_interval(mins => ${pickupGraceMinutes}) <= ${now.toISOString()}::timestamptz`,
        // Only recent ones: an old backlog is not re-announced.
        sql`${orderFulfilmentArrangements.scheduledEnd} > ${now.toISOString()}::timestamptz - interval '7 days'`,
        notInArray(orders.source, ["SUBSCRIPTION"]),
      ),
    )
    .limit(200);
  for (const row of due) {
    await notify({
      userId: row.ownerId,
      type: NOTIFICATION_TYPES.SHOP_PICKUP_NOT_COLLECTED,
      title: "Pickup not collected",
      body: `Order ${row.orderNumber} was not collected in its pickup time. You may cancel it as not collected (the customer is refunded).`,
      actionUrl: "/shop/orders",
      dedupeKey: `flows-v3:pickup-not-collected:${row.orderId}`,
    });
  }
  return due.length;
}

/** A shop's pickups past their slot + grace and still not collected (the shop's Orders page). */
export async function listUncollectedPickupsForShop(shopId: string, now: Date = new Date()) {
  if (!(await flowOn("flow_f19"))) return [];
  const { pickupGraceMinutes } = await flowsV3Rule();
  return db
    .select({ orderId: orders.id, orderNumber: orders.orderNumber, slotEnd: orderFulfilmentArrangements.scheduledEnd })
    .from(orderFulfilmentArrangements)
    .innerJoin(orders, eq(orders.id, orderFulfilmentArrangements.orderId))
    .where(
      and(
        eq(orders.shopId, shopId),
        eq(orderFulfilmentArrangements.option, "PICKUP"),
        isNull(orderFulfilmentArrangements.completedAt),
        eq(orders.status, "READY"),
        sql`${orderFulfilmentArrangements.scheduledEnd} + make_interval(mins => ${pickupGraceMinutes}) <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(orderFulfilmentArrangements.scheduledEnd)
    .limit(50);
}
