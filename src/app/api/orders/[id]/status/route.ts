/**
 * Advance an order's status (§41), or cancel with an automatic refund.
 *
 * A shop owner may only move their own shop's orders; operators and admins may
 * move any. Illegal transitions are rejected by the state machine.
 *
 * `CONFIRMED` is deliberately NOT an accepted target here (DEF-06 —
 * docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): the only legitimate paths
 * to CONFIRMED are checkout() and the subscription retry, both of which
 * check payment first. This generic endpoint has no such check, so letting
 * it accept CONFIRMED let a shop/operator mark an unpaid order as if paid.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { forbidden } from "@/lib/errors";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { markOrderReady } from "@/server/services/fulfilment";
import { cancelOrder, updateOrderStatus } from "@/server/services/orders";

const schema = z.object({
  status: z.enum([
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    // Slice 4 exceptions: goods back at the shop after a failed delivery;
    // a delivered order under dispute (operations only).
    "RETURNED",
    "DISPUTED",
  ]),
  note: z.string().max(300).optional(),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const body = await parseBody(request, schema);

    const order = await db.query.orders.findFirst({
      where: eq(orders.id, id),
      columns: { id: true, shopId: true, userId: true },
    });
    if (!order) throw notFound("Order");

    if (body.status === "CANCELLED") {
      // A customer may cancel their own order (self-service, subject to
      // D10's status gate and goods-only-refund rule inside cancelOrder);
      // shop staff or an operator may cancel any order at their own shop,
      // unrestricted, exactly as before.
      const user = await requireUser();
      const isOwnOrder = order.userId === user.id;
      if (!isOwnOrder) {
        await requireShopAccess(order.shopId, {
          anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY,
        });
      }
      return ok(
        await cancelOrder(id, user, body.note ?? "Cancelled", {
          selfService: isOwnOrder,
        }),
      );
    }

    const { user } = await requireShopAccess(order.shopId, {
      anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY,
    });
    if (body.status === "DISPUTED" && !can(user.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY)) {
      throw forbidden("Only operations can open a dispute on an order.");
    }
    // READY goes through fulfilment so pending substitutions block it and a
    // rider is requested automatically (Slice 3/4).
    if (body.status === "READY") return ok(await markOrderReady(id, user));
    return ok(await updateOrderStatus(id, body.status, user, body.note));
  },
);
