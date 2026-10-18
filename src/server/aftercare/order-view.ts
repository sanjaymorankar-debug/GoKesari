/**
 * The customer order detail page's aftercare section (batch-2026-10 WS-C):
 * refunds with their timeline, the charges kept, and the order's tickets.
 * Readable by the buyer, the shop's owner and support only.
 */
import { asc, eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orderCharges, orders, shops, type Order, type UserRole } from "@/server/db/schema";
import { listRefundsForOrder, type RefundView } from "./refunds";

interface Viewer {
  id: string;
  role: UserRole;
}

export async function assertOrderViewer(orderId: string, user: Viewer): Promise<Order & { shopName: string }> {
  const [row] = await db
    .select({ order: orders, shopName: shops.name, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  if (!row) throw notFound("Order");
  const allowed =
    row.order.userId === user.id || row.ownerId === user.id || can(user.role, PERMISSIONS.ORDER_VIEW_ANY);
  if (!allowed) throw notFound("Order");
  return { ...row.order, shopName: row.shopName };
}

export async function getOrderRefundsFor(orderId: string, user: Viewer): Promise<RefundView[]> {
  await assertOrderViewer(orderId, user);
  return listRefundsForOrder(orderId);
}

export async function listChargesForOrder(orderId: string) {
  return db.select().from(orderCharges).where(eq(orderCharges.orderId, orderId)).orderBy(asc(orderCharges.createdAt));
}
