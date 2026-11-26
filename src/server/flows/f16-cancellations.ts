/**
 * Flow spec v3 F16, cancellations / refunds / returns (docs/flows-v3/wave2.md; flag flow_f16; rule orderFlowsV3).
 *
 *   - Cancel until packing: wave2-rules.ts (cancellationRule) lets the customer cancel ACCEPTED / PREPARING orders
 *     with a full refund (delivery fee included) through the existing cancel path.
 *   - After packing (READY / ASSIGNED): the customer asks the shop (order_cancel_requests); the shop agrees — the
 *     order is cancelled through the shop's cancel path with a full refund (no charge, owner 27-Nov-2026) — or
 *     declines and the order carries on.
 *   - Returns: food / medicine categories are not returnable except for the listed defect reasons
 *     (assertLinesReturnable); a declined return can be taken to a dispute (disputeDeclinedReturn); the shop is told
 *     when a return is refunded (notifyShopReturnRefunded).
 *   - Failed delivery: a rider delivery marked failed and not retried within failedDeliveryRefundAfterMinutes is
 *     cancelled by the system with a full refund (runFailedDeliveryRefunds).
 * Notifications are sent after the work has committed.
 */
import { and, desc, eq, inArray, lt, notExists, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { RETURN_REASON_LABELS, type ReturnReason } from "@/lib/return-states";
import type { DisputeReason } from "@/lib/dispute-states";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  orderCancelRequests,
  orderDisputes,
  orderItems,
  orders,
  productCategories,
  products,
  returnRequests,
  shopProducts,
  shops,
  type OrderCancelRequest,
  type OrderStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { cancelOrder } from "@/server/services/orders";
import { flowOn, flowsV3Rule } from "./wave2-rules";

interface Actor {
  id: string;
  role: UserRole;
}

/** Packed and not yet with a rider: the statuses a customer asks the shop about (the after-packing statuses). */
export const CANCEL_REQUEST_STATUSES: readonly OrderStatus[] = ["READY", "ASSIGNED"];

async function assertF16(): Promise<void> {
  if (!(await flowOn("flow_f16"))) throw notFound("Order");
}

/* ------------------------------------------------- cancel after packing */

export async function getPendingCancelRequest(orderId: string): Promise<OrderCancelRequest | null> {
  const [row] = await db
    .select()
    .from(orderCancelRequests)
    .where(and(eq(orderCancelRequests.orderId, orderId), eq(orderCancelRequests.status, "PENDING")))
    .limit(1);
  return row ?? null;
}

/** The latest request on an order (any status), for the customer's page. */
export async function getLatestCancelRequest(orderId: string): Promise<OrderCancelRequest | null> {
  const [row] = await db.select().from(orderCancelRequests).where(eq(orderCancelRequests.orderId, orderId)).orderBy(desc(orderCancelRequests.createdAt)).limit(1);
  return row ?? null;
}

/** The customer asks the shop to cancel a packed order. */
export async function requestCancellation(orderId: string, actor: Actor, reason?: string | null): Promise<OrderCancelRequest> {
  await assertF16();
  const [order] = await db
    .select({ id: orders.id, userId: orders.userId, status: orders.status, orderNumber: orders.orderNumber, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  if (!order || order.userId !== actor.id) throw notFound("Order");
  if (!CANCEL_REQUEST_STATUSES.includes(order.status)) {
    throw conflict("You can ask the shop to cancel only a packed order that has not left the shop yet.");
  }
  const text = reason?.trim().slice(0, 300) || null;
  const [created] = await db.insert(orderCancelRequests).values({ orderId, userId: actor.id, reason: text }).onConflictDoNothing().returning();
  if (!created) throw conflict("You have already asked the shop to cancel this order.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.ORDER_CANCEL_REQUESTED,
    entityType: "order_cancel_request",
    entityId: created.id,
    newValue: { orderId, reason: text },
  });
  await notify({
    userId: order.ownerId,
    type: NOTIFICATION_TYPES.SHOP_CANCEL_REQUESTED,
    title: "Customer asks to cancel a packed order",
    body: `The customer of order ${order.orderNumber} asks you to cancel it${text ? `: ${text}` : ""}. Agree (the customer is refunded in full) or decline in Orders.`,
    actionUrl: "/shop/orders",
    dedupeKey: `flows-v3:cancel-request:${created.id}`,
  });
  return created;
}

/** The customer withdraws their request while the shop has not decided. */
export async function withdrawCancelRequest(orderId: string, actor: Actor): Promise<void> {
  await assertF16();
  const updated = await db
    .update(orderCancelRequests)
    .set({ status: "WITHDRAWN", updatedAt: new Date() })
    .where(and(eq(orderCancelRequests.orderId, orderId), eq(orderCancelRequests.userId, actor.id), eq(orderCancelRequests.status, "PENDING")))
    .returning({ id: orderCancelRequests.id });
  if (updated.length === 0) throw conflict("There is no open cancellation request on this order.");
}

/**
 * The shop agrees or declines. `shopStaff`: the route already checked a staff grant (requireShopPermission);
 * otherwise the actor must own the shop or work in operations.
 */
export async function decideCancelRequest(
  orderId: string,
  actor: Actor,
  input: { accept: boolean; note?: string | null },
  options: { shopStaff?: boolean } = {},
): Promise<{ request: OrderCancelRequest; orderStatus: OrderStatus }> {
  await assertF16();
  const [order] = await db
    .select({ id: orders.id, userId: orders.userId, status: orders.status, orderNumber: orders.orderNumber, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
  if (order.ownerId !== actor.id && !options.shopStaff && !can(actor.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY)) {
    throw forbidden("Only the shop can answer this request.");
  }
  const pending = await getPendingCancelRequest(orderId);
  if (!pending) throw conflict("There is no open cancellation request on this order.");
  const note = input.note?.trim().slice(0, 300) || null;

  if (!CANCEL_REQUEST_STATUSES.includes(order.status)) {
    // The order moved on (picked up, delivered, cancelled): the request is closed without a decision.
    const [closed] = await db
      .update(orderCancelRequests)
      .set({ status: "CLOSED", decidedAt: new Date(), decidedBy: actor.id, decisionNote: "The order had moved on", updatedAt: new Date() })
      .where(and(eq(orderCancelRequests.id, pending.id), eq(orderCancelRequests.status, "PENDING")))
      .returning();
    throw conflict("This order has already moved on, so the request was closed.", { requestId: closed?.id ?? pending.id });
  }

  let orderStatus: OrderStatus = order.status;
  if (input.accept) {
    // The shop's own cancel: a full refund (delivery fee included), restock, rider released — no charge.
    const cancelled = await cancelOrder(
      orderId,
      actor,
      `Cancelled at the customer's request, agreed by the shop${pending.reason ? `: ${pending.reason}` : ""}`,
      { onlyIfStatus: order.status },
    );
    orderStatus = cancelled.status;
  }
  const [decided] = await db
    .update(orderCancelRequests)
    .set({ status: input.accept ? "ACCEPTED" : "DECLINED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() })
    .where(and(eq(orderCancelRequests.id, pending.id), eq(orderCancelRequests.status, "PENDING")))
    .returning();
  if (!decided) throw conflict("This request was already answered.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.ORDER_CANCEL_REQUEST_DECIDED,
    entityType: "order_cancel_request",
    entityId: decided.id,
    newValue: { orderId, accepted: input.accept, note },
  });
  await notify({
    userId: order.userId,
    type: NOTIFICATION_TYPES.ORDER_CANCEL_REQUEST_DECIDED,
    title: input.accept ? "The shop cancelled your order" : "The shop could not cancel your order",
    body: input.accept
      ? `The shop agreed to cancel order ${order.orderNumber}. Your refund is on its way.`
      : `The shop declined to cancel order ${order.orderNumber}${note ? `: ${note}` : ""}. It will be delivered as planned.`,
    actionUrl: `/orders/${orderId}`,
    dedupeKey: `flows-v3:cancel-request-decided:${decided.id}`,
  });
  return { request: decided, orderStatus };
}

/** Pending requests of one shop (the shop's Orders page). */
export async function listPendingCancelRequestsForShop(shopId: string) {
  if (!(await flowOn("flow_f16"))) return [];
  return db
    .select({ requestId: orderCancelRequests.id, orderId: orders.id, orderNumber: orders.orderNumber, status: orders.status, reason: orderCancelRequests.reason, createdAt: orderCancelRequests.createdAt })
    .from(orderCancelRequests)
    .innerJoin(orders, eq(orders.id, orderCancelRequests.orderId))
    .where(and(eq(orders.shopId, shopId), eq(orderCancelRequests.status, "PENDING")))
    .orderBy(orderCancelRequests.createdAt);
}

/* ------------------------------------------------------------ returns */

/**
 * Food and medicine (rule orderFlowsV3.nonReturnableDepartments / nonReturnableCategorySlugs) cannot be returned,
 * except for nonReturnableExceptReasons. Checks the product actually delivered (a substitute replaces the original).
 * No-op while flow_f16 is off.
 */
export async function assertLinesReturnable(client: DbClient, orderItemIds: string[], reason: ReturnReason): Promise<void> {
  if (orderItemIds.length === 0 || !(await flowOn("flow_f16"))) return;
  const rule = await flowsV3Rule();
  if (rule.nonReturnableExceptReasons.includes(reason)) return;
  const departments = new Set(rule.nonReturnableDepartments);
  const slugs = new Set(rule.nonReturnableCategorySlugs);
  if (departments.size === 0 && slugs.size === 0) return;
  const rows = await client
    .select({ name: orderItems.productNameSnapshot, department: productCategories.department, slug: productCategories.slug })
    .from(orderItems)
    .innerJoin(shopProducts, sql`${shopProducts.id} = COALESCE(${orderItems.substituteShopProductId}, ${orderItems.shopProductId})`)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(inArray(orderItems.id, orderItemIds));
  const blocked = rows.filter((r) => departments.has(r.department) || slugs.has(r.slug));
  if (blocked.length > 0) {
    const allowed = rule.nonReturnableExceptReasons.map((r) => RETURN_REASON_LABELS[r as ReturnReason] ?? r).join(", ");
    throw validationFailed(
      `${blocked.map((b) => b.name).join(", ")} cannot be returned (food and medicines are not returnable)${allowed ? ` unless the reason is: ${allowed.toLowerCase()}` : ""}.`,
    );
  }
}

const DISPUTE_REASON_FOR: Record<ReturnReason, DisputeReason> = {
  DAMAGED: "ITEM_DAMAGED",
  WRONG_ITEM: "WRONG_ITEM",
  QUALITY_ISSUE: "QUALITY_ISSUE",
  EXPIRED: "QUALITY_ISSUE",
  MISSING_ITEM: "SHORT_QUANTITY",
  NOT_AS_DESCRIBED: "NOT_AS_DESCRIBED",
  CHANGED_MIND: "OTHER",
  OTHER: "OTHER",
};

/** Whether this declined return can be taken to a dispute now (and the dispute already opened from it, if any). */
export async function declinedReturnDisputeState(returnId: string, userId: string): Promise<{ canDispute: boolean; disputeId: string | null }> {
  if (!(await flowOn("flow_f16"))) return { canDispute: false, disputeId: null };
  const [ret] = await db.select({ status: returnRequests.status, userId: returnRequests.userId }).from(returnRequests).where(eq(returnRequests.id, returnId));
  if (!ret || ret.userId !== userId || ret.status !== "REJECTED") return { canDispute: false, disputeId: null };
  const [existing] = await db.select({ id: orderDisputes.id }).from(orderDisputes).where(eq(orderDisputes.returnRequestId, returnId)).limit(1);
  return { canDispute: !existing, disputeId: existing?.id ?? null };
}

/**
 * The customer disagrees with a declined return: opens a dispute on the order for the return's value, linked to the
 * return (openDispute — which, where the help-desk flow is on, also opens its support ticket).
 */
export async function disputeDeclinedReturn(returnId: string, actor: Actor, description: string) {
  await assertF16();
  const [ret] = await db.select().from(returnRequests).where(eq(returnRequests.id, returnId));
  if (!ret || ret.userId !== actor.id) throw notFound("Return");
  if (ret.status !== "REJECTED") throw conflict("Only a declined return can be taken to a dispute.");
  const [existing] = await db.select({ id: orderDisputes.id }).from(orderDisputes).where(eq(orderDisputes.returnRequestId, returnId)).limit(1);
  if (existing) throw conflict("A dispute is already open for this return.");
  const text = description.trim();
  const { openDispute } = await import("@/server/services/disputes");
  return openDispute(
    {
      orderId: ret.orderId,
      reason: DISPUTE_REASON_FOR[ret.reason],
      description: `Return ${ret.returnNumber} (${RETURN_REASON_LABELS[ret.reason]}) was declined by the shop${ret.decisionNote ? `: "${ret.decisionNote}"` : ""}. ${text}`.slice(0, 4000),
      disputedAmountPaise: ret.refundAmountPaise,
      returnRequestId: ret.id,
    },
    actor,
  );
}

/** After a return's refund (flag flow_f16): the shop is told its share was reversed. Never throws. */
export async function notifyShopReturnRefunded(ret: { id: string; shopId: string; returnNumber: string; refundAmountPaise: number }): Promise<void> {
  try {
    if (!(await flowOn("flow_f16"))) return;
    const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, ret.shopId));
    if (!shop) return;
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_RETURN_REFUNDED,
      title: "Return refunded",
      body: `Return ${ret.returnNumber} was refunded to the customer (₹${(ret.refundAmountPaise / 100).toFixed(2)}). Your share and commission for it were adjusted.`,
      actionUrl: "/shop/returns",
      dedupeKey: `flows-v3:return-refunded:${ret.id}`,
    });
  } catch (error) {
    console.error("[flows-v3] shop return-refund notice failed", ret.id, error);
  }
}

/* ------------------------------------------------------ failed delivery */

export const FAILED_DELIVERY_REFUND_REASON = "Delivery could not be completed — refunded automatically";

export async function runFailedDeliveryRefunds(now: Date = new Date()): Promise<{ cancelled: number; skipped: number }> {
  const result = { cancelled: 0, skipped: 0 };
  if (!(await flowOn("flow_f16"))) return result;
  const { failedDeliveryRefundAfterMinutes } = await flowsV3Rule();
  const cutoff = new Date(now.getTime() - failedDeliveryRefundAfterMinutes * 60_000);
  const due = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ["FAILED", "RETURNED"]),
        sql`EXISTS (SELECT 1 FROM ${deliveryOrders} d WHERE d.order_id = ${orders.id} AND d.status = 'FAILED' AND d.failed_at < ${cutoff.toISOString()}::timestamptz)`,
        // A new delivery attempt is under way: leave it.
        notExists(
          db
            .select({ one: sql`1` })
            .from(deliveryOrders)
            .where(and(eq(deliveryOrders.orderId, orders.id), inArray(deliveryOrders.status, ["OFFERED", "ACCEPTED", "PICKED_UP"]))),
        ),
        lt(orders.updatedAt, cutoff),
      ),
    )
    .limit(100);
  for (const row of due) {
    try {
      await cancelOrder(row.id, null, FAILED_DELIVERY_REFUND_REASON, { onlyIfStatus: row.status });
      result.cancelled += 1;
    } catch (error) {
      if (!(error instanceof AppError)) console.error("[flows-v3] failed-delivery refund failed", row.id, error);
      result.skipped += 1;
    }
  }
  return result;
}
