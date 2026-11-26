/**
 * docs/flows-v3/wave2.md (flag flow_f19): the shop cancels a pickup the customer did not collect within the slot
 * and the grace (rule orderFlowsV3.pickupGraceMinutes). Full refund. 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { cancelUncollectedPickup } from "@/server/flows/f19-timeouts";
import { toOrderStatusView } from "@/server/services/orders";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireUser();
  const { id } = await context.params;
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { shopId: true } });
  if (!order) throw notFound("Order");
  const access = await requireShopPermission(order.shopId, "orders.cancel", { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  return ok(toOrderStatusView(await cancelUncollectedPickup(id, access.user, new Date(), { shopStaff: true })));
});
