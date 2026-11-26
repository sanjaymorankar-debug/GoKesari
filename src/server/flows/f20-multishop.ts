/**
 * Flow spec v3 F20, multi-shop cart (docs/flows-v3/wave2.md; flag flow_f20).
 *
 * A multi-shop checkout is one order per shop under one order group. When one shop declines or cancels its part
 * (anyone but the customer), the customer is told and offered to cancel the other parts that are still
 * cancellable by them — each through the customer's own cancel path (full refund before packing). Only that part
 * was refunded already (the existing per-order refund). Nothing changes while the flag is off.
 */
import { and, eq, ne } from "drizzle-orm";

import { customerCancellableStatuses } from "@/lib/order-cancellation";
import { AppError, conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { orders, shops, type OrderStatus, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { cancelOrder } from "@/server/services/orders";
import { afterPackingCancellationRule, cancellationRule, flowOn } from "./wave2-rules";

interface Actor {
  id: string;
  role: UserRole;
}

const CANCELLED_STATUSES: readonly OrderStatus[] = ["CANCELLED", "REFUNDED", "REFUND_PENDING"];

async function cancellableStatuses(): Promise<readonly OrderStatus[]> {
  return customerCancellableStatuses({
    customerMayCancelUntil: (await cancellationRule()).customerMayCancelUntil,
    afterPackingEnabled: (await afterPackingCancellationRule()).enabled,
  });
}

/** The other parts of the order's group the customer may still cancel. */
async function cancellableSiblings(order: { id: string; orderGroupId: string | null; userId: string }) {
  if (!order.orderGroupId) return [];
  const statuses = await cancellableStatuses();
  const siblings = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, shopName: shops.name })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(and(eq(orders.orderGroupId, order.orderGroupId), eq(orders.userId, order.userId), ne(orders.id, order.id)));
  return siblings.filter((s) => statuses.includes(s.status));
}

/** After a part of a group was cancelled by the shop, support or the system: tell the customer. Never throws. */
export async function notifyGroupPartCancelled(orderId: string, cancelledByCustomer: boolean): Promise<void> {
  try {
    if (cancelledByCustomer || !(await flowOn("flow_f20"))) return;
    const [order] = await db
      .select({ id: orders.id, orderGroupId: orders.orderGroupId, userId: orders.userId, orderNumber: orders.orderNumber, shopName: shops.name })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, orderId));
    if (!order?.orderGroupId) return;
    const rest = await cancellableSiblings(order);
    if (rest.length === 0) return;
    await notify({
      userId: order.userId,
      type: NOTIFICATION_TYPES.ORDER_GROUP_PART_CANCELLED,
      title: `${order.shopName} could not fulfil its part`,
      body: `Order ${order.orderNumber} from ${order.shopName} was cancelled and refunded. Your other ${rest.length === 1 ? "order" : `${rest.length} orders`} from the same checkout continue — you may cancel ${rest.length === 1 ? "it" : "them"} too.`,
      actionUrl: `/orders/${order.id}`,
      metadata: { orderId, orderGroupId: order.orderGroupId },
      dedupeKey: `flows-v3:group-part-cancelled:${orderId}`,
    });
  } catch (error) {
    console.error("[flows-v3] group part notice failed", orderId, error);
  }
}

export interface GroupRestState {
  /** Offer "Cancel the other orders" on this order's page. */
  offer: boolean;
  orders: { id: string; orderNumber: string; shopName: string }[];
}

/** For the customer's order page: this part was cancelled and other parts may still be cancelled. */
export async function groupRestState(orderId: string, userId: string): Promise<GroupRestState> {
  const none = { offer: false, orders: [] };
  if (!(await flowOn("flow_f20"))) return none;
  const [order] = await db.select({ id: orders.id, orderGroupId: orders.orderGroupId, userId: orders.userId, status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.userId !== userId || !order.orderGroupId || !CANCELLED_STATUSES.includes(order.status)) return none;
  const rest = await cancellableSiblings(order);
  return { offer: rest.length > 0, orders: rest.map((r) => ({ id: r.id, orderNumber: r.orderNumber, shopName: r.shopName })) };
}

/** The customer cancels the remaining parts of the group (each by their own cancel path). */
export async function cancelRemainingGroupOrders(orderId: string, actor: Actor) {
  if (!(await flowOn("flow_f20"))) throw notFound("Order");
  const [order] = await db.select({ id: orders.id, orderGroupId: orders.orderGroupId, userId: orders.userId }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.userId !== actor.id) throw notFound("Order");
  if (!order.orderGroupId) throw conflict("This order was not part of a multi-shop checkout.");
  const rest = await cancellableSiblings(order);
  const cancelled: string[] = [];
  const kept: { orderNumber: string; reason: string }[] = [];
  for (const sibling of rest) {
    try {
      await cancelOrder(sibling.id, actor, "Cancelled by the customer after another shop could not fulfil its part", { selfService: true });
      cancelled.push(sibling.orderNumber);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      kept.push({ orderNumber: sibling.orderNumber, reason: error.message });
    }
  }
  return { cancelled, kept };
}
