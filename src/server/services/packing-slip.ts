/**
 * Printable packing slip for a packed order (F4.1.3 — batch-2026-10 WS-B):
 * items and quantities, order number, the customer's first name and area only
 * (no phone, no street address), the short pickup code once a rider has
 * accepted, and the signed pickup QR while rule pickupQr is on.
 * The shop's owner (or operations with order:view:any) only.
 */
import { asc, eq } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import { formatQuantity } from "@/lib/money";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { deliveryOrders, orderItems, orders, shops, users, type UserRole } from "@/server/db/schema";
import { getPickupQrForOrder, type ShopPickupQr } from "./pickup-qr";

export interface PackingSlip {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  placedAt: string;
  shopName: string;
  customerFirstName: string;
  customerArea: string;
  items: { name: string; quantity: string; note: string | null }[];
  /** The 4-digit code the rider gives at handover — only once a rider has accepted. */
  pickupCode: string | null;
  qr: ShopPickupQr | null;
  paymentNote: string | null;
}

export async function getPackingSlip(orderId: string, viewer: { id: string; role: UserRole }): Promise<PackingSlip> {
  const [row] = await db
    .select({ order: orders, shopName: shops.name, ownerId: shops.ownerId, customerName: users.name })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) throw notFound("Order");
  if (row.ownerId !== viewer.id && !can(viewer.role, PERMISSIONS.ORDER_VIEW_ANY)) {
    throw forbidden("This order does not belong to your shop.");
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.createdAt));
  const [delivery] = await db
    .select({ status: deliveryOrders.status, pickupCode: deliveryOrders.pickupCode })
    .from(deliveryOrders)
    .where(eq(deliveryOrders.orderId, orderId));
  const snapshot = row.order.deliveryAddressSnapshot;

  return {
    orderId,
    orderNumber: row.order.orderNumber,
    orderStatus: row.order.status,
    placedAt: row.order.createdAt.toISOString(),
    shopName: row.shopName,
    customerFirstName: (row.customerName ?? "").trim().split(/\s+/)[0] || "Customer",
    customerArea: [snapshot?.area, snapshot?.city].filter(Boolean).join(", ") || "—",
    items: items
      .filter((i) => i.fulfilmentStatus !== "REMOVED")
      .map((i) =>
        i.fulfilmentStatus === "SUBSTITUTED" && i.substituteNameSnapshot && i.substituteUnitSnapshot && i.substituteQuantityMilli != null
          ? {
              name: i.substituteNameSnapshot,
              quantity: formatQuantity(i.substituteQuantityMilli, i.substituteUnitSnapshot),
              note: `instead of ${i.productNameSnapshot}`,
            }
          : { name: i.productNameSnapshot, quantity: formatQuantity(i.quantityMilli, i.unitSnapshot), note: null },
      ),
    pickupCode: delivery?.status === "ACCEPTED" && row.order.status === "ASSIGNED" ? delivery.pickupCode : null,
    qr: await getPickupQrForOrder(orderId),
    paymentNote: row.order.paymentMethod === "COD" ? "Cash on delivery — the rider collects payment" : null,
  };
}
