/**
 * Ratings (Phase 2 — GS-059 shop rating, GS-060 rider rating).
 *
 *   DELIVERED order → customer is eligible (30 days) → rates the shop and,
 *   when a platform rider delivered it, the rider → one row per target,
 *   never twice → shop / rider average recomputed from VISIBLE ratings.
 *
 * Visibility: shop ratings and comments are public on the shop page as
 * "Verified customer" (no names). Rider ratings are shown only to that rider
 * and to operations — never publicly. Operations can hide a rating
 * (moderation); hidden ratings drop out of the average.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  orderRatings,
  orderStatusHistory,
  orders,
  shops,
  type OrderRating,
  type RatingTarget,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

/** How long after delivery a customer may rate. */
export const RATING_WINDOW_DAYS = 30;
const MAX_COMMENT = 500;

export interface RatingEligibility {
  canRateShop: boolean;
  canRateRider: boolean;
  /** Why not, when neither is possible. */
  reason: string | null;
  existing: { shop: OrderRating | null; rider: OrderRating | null };
  deliveryPartnerId: string | null;
}

/** Eligibility for one order and one customer — used by the UI and enforced on submit. */
export async function getRatingEligibility(orderId: string, customerId: string, client: DbClient = db): Promise<RatingEligibility> {
  const order = await client.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order || order.userId !== customerId) throw notFound("Order");

  const existing = await client.select().from(orderRatings).where(eq(orderRatings.orderId, orderId));
  const shopRating = existing.find((r) => r.targetType === "SHOP") ?? null;
  const riderRating = existing.find((r) => r.targetType === "DELIVERY_PARTNER") ?? null;
  const delivery = await client.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  const riderDelivered = delivery?.status === "DELIVERED" ? delivery.deliveryPartnerId : null;

  const base = { existing: { shop: shopRating, rider: riderRating }, deliveryPartnerId: riderDelivered };
  if (order.status !== "DELIVERED" && order.status !== "DISPUTED") {
    return { ...base, canRateShop: false, canRateRider: false, reason: "You can rate an order once it has been delivered." };
  }
  const [deliveredAt] = await client
    .select({ at: orderStatusHistory.createdAt })
    .from(orderStatusHistory)
    .where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.newStatus, "DELIVERED")))
    .orderBy(orderStatusHistory.createdAt)
    .limit(1);
  const since = deliveredAt?.at ?? order.updatedAt;
  if (Date.now() - since.getTime() > RATING_WINDOW_DAYS * 86_400_000) {
    return { ...base, canRateShop: false, canRateRider: false, reason: `Ratings close ${RATING_WINDOW_DAYS} days after delivery.` };
  }
  return {
    ...base,
    canRateShop: shopRating == null,
    canRateRider: riderRating == null && riderDelivered != null,
    reason: null,
  };
}

/** Recompute an aggregate from VISIBLE ratings and store it (average × 100 + count). */
async function refreshAggregate(target: RatingTarget, id: string, client: DbClient): Promise<void> {
  const column = target === "SHOP" ? orderRatings.shopId : orderRatings.deliveryPartnerId;
  const [agg] = await client
    .select({
      count: sql<number>`count(*)::int`,
      avgX100: sql<number>`coalesce(round(avg(${orderRatings.score}) * 100), 0)::int`,
    })
    .from(orderRatings)
    .where(and(eq(column, id), eq(orderRatings.targetType, target), eq(orderRatings.status, "VISIBLE")));
  if (target === "SHOP") {
    await client.update(shops).set({ ratingAvgX100: agg.avgX100, ratingCount: agg.count }).where(eq(shops.id, id));
  } else {
    await client
      .update(deliveryPartners)
      .set({ ratingAvgX100: agg.avgX100, ratingCount: agg.count })
      .where(eq(deliveryPartners.id, id));
  }
}

export interface SubmitRatingInput {
  orderId: string;
  target: RatingTarget;
  score: number;
  comment?: string | null;
}

/** Create a rating after checking eligibility; duplicates are refused (also by a unique index). */
export async function submitRating(input: SubmitRatingInput, actor: Actor): Promise<OrderRating> {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw validationFailed("Give a rating from 1 to 5 stars.");
  }
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > MAX_COMMENT) throw validationFailed(`Keep the review under ${MAX_COMMENT} characters.`);

  return db.transaction(async (tx) => {
    const eligibility = await getRatingEligibility(input.orderId, actor.id, tx);
    const allowed = input.target === "SHOP" ? eligibility.canRateShop : eligibility.canRateRider;
    if (!allowed) {
      const already = input.target === "SHOP" ? eligibility.existing.shop : eligibility.existing.rider;
      if (already) throw conflict("You have already rated this.");
      throw forbidden(eligibility.reason ?? "This order cannot be rated.");
    }
    const order = (await tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) }))!;
    const [rating] = await tx
      .insert(orderRatings)
      .values({
        orderId: order.id,
        targetType: input.target,
        customerId: actor.id,
        shopId: order.shopId,
        deliveryPartnerId: input.target === "DELIVERY_PARTNER" ? eligibility.deliveryPartnerId : null,
        score: input.score,
        comment,
      })
      .returning();
    await refreshAggregate(input.target, input.target === "SHOP" ? order.shopId : eligibility.deliveryPartnerId!, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RATING_CREATED,
        entityType: "order_rating",
        entityId: rating.id,
        newValue: { orderId: order.id, target: input.target, score: input.score },
      },
      tx,
    );
    return rating;
  });
}

/** Operations hides (or restores) a rating; the aggregate follows. */
export async function moderateRating(ratingId: string, hide: boolean, reason: string, actor: Actor): Promise<OrderRating> {
  const trimmed = reason.trim();
  if (hide && trimmed.length < 3) throw validationFailed("Give a reason for hiding it.");
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(orderRatings).where(eq(orderRatings.id, ratingId)).for("update");
    if (!current) throw notFound("Rating");
    const [updated] = await tx
      .update(orderRatings)
      .set({
        status: hide ? "HIDDEN" : "VISIBLE",
        moderatedBy: actor.id,
        moderatedAt: new Date(),
        moderationReason: hide ? trimmed : null,
      })
      .where(eq(orderRatings.id, ratingId))
      .returning();
    await refreshAggregate(
      current.targetType,
      current.targetType === "SHOP" ? current.shopId : current.deliveryPartnerId!,
      tx,
    );
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RATING_MODERATED,
        entityType: "order_rating",
        entityId: ratingId,
        previousValue: { status: current.status },
        newValue: { status: updated.status, reason: trimmed || null },
      },
      tx,
    );
    return updated;
  });
}

/** Public shop reviews: visible only, no customer identity. */
export async function listShopReviews(shopId: string, limit = 10) {
  return db
    .select({ id: orderRatings.id, score: orderRatings.score, comment: orderRatings.comment, createdAt: orderRatings.createdAt })
    .from(orderRatings)
    .where(and(eq(orderRatings.shopId, shopId), eq(orderRatings.targetType, "SHOP"), eq(orderRatings.status, "VISIBLE")))
    .orderBy(desc(orderRatings.createdAt))
    .limit(limit);
}

/** A rider's own feedback (no customer identity). */
export async function listRiderFeedback(deliveryPartnerId: string, limit = 10) {
  return db
    .select({ id: orderRatings.id, score: orderRatings.score, comment: orderRatings.comment, createdAt: orderRatings.createdAt })
    .from(orderRatings)
    .where(
      and(
        eq(orderRatings.deliveryPartnerId, deliveryPartnerId),
        eq(orderRatings.targetType, "DELIVERY_PARTNER"),
        eq(orderRatings.status, "VISIBLE"),
      ),
    )
    .orderBy(desc(orderRatings.createdAt))
    .limit(limit);
}

/** Moderation queue: most recent ratings of both kinds, with order and target names (no customer PII). */
export async function listRatingsForModeration(limit = 100) {
  return db
    .select({
      rating: orderRatings,
      orderNumber: orders.orderNumber,
      shopName: shops.name,
      riderName: deliveryPartners.fullName,
    })
    .from(orderRatings)
    .innerJoin(orders, eq(orderRatings.orderId, orders.id))
    .innerJoin(shops, eq(orderRatings.shopId, shops.id))
    .leftJoin(deliveryPartners, eq(orderRatings.deliveryPartnerId, deliveryPartners.id))
    .orderBy(desc(orderRatings.createdAt))
    .limit(limit);
}

/** Ratings a customer gave, keyed by order — for their order list. */
export async function listMyRatingsByOrder(customerId: string, orderIds: readonly string[]) {
  if (orderIds.length === 0) return new Map<string, { shop?: number; rider?: number }>();
  const rows = await db
    .select({ orderId: orderRatings.orderId, targetType: orderRatings.targetType, score: orderRatings.score })
    .from(orderRatings)
    .where(and(eq(orderRatings.customerId, customerId), inArray(orderRatings.orderId, [...orderIds])));
  const map = new Map<string, { shop?: number; rider?: number }>();
  for (const r of rows) {
    const entry = map.get(r.orderId) ?? {};
    if (r.targetType === "SHOP") entry.shop = r.score;
    else entry.rider = r.score;
    map.set(r.orderId, entry);
  }
  return map;
}
