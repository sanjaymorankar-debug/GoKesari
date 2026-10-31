/**
 * The event for an order status written outside updateOrderStatus — the
 * refund steps that follow a cancellation (CANCELLED → REFUNDED for a wallet
 * refund, CANCELLED → REFUND_PENDING for one to the original method). The
 * move is checked against the order state machine and logged in
 * domain_events like every other change; the refund itself is announced by
 * the refund code, so this event notifies nobody (order.status_changed).
 */
import { eq } from "drizzle-orm";

import type { DbClient } from "@/server/db";
import { orders, shops, type UserRole } from "@/server/db/schema";
import { emitEvent } from "./emit";

export async function recordOrderStatusEvent(
  tx: DbClient,
  orderId: string,
  from: string,
  to: string,
  actor: { id: string | null; role: UserRole | null } | null,
  note: string,
): Promise<void> {
  const [row] = await tx
    .select({ orderNumber: orders.orderNumber, buyerId: orders.userId, shopOwnerId: shops.ownerId, shopName: shops.name })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  if (!row) return;
  await emitEvent(
    {
      type: "order.status_changed",
      subjectId: orderId,
      orderId,
      transition: { from, to },
      actor: actor ?? { id: null, role: null },
      payload: { orderId, ...row, reason: note },
    },
    tx,
  );
}
