/**
 * docs/hdms-2026-11: the shop asks GoKesari to find delivery now for one of its READY orders (its own rider
 * if marked on duty and the shop delivers itself, else a GoKesari rider, else a delivery partner).
 * Own shop only: an order of another shop is "not found".
 */
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { allocateOrder } from "@/server/delivery/allocation";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string; orderId: string }>) => {
  const { id, orderId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY });
  enforceRateLimit(`delivery-partner:${user.id}`, RATE_LIMITS.MUTATION);
  const [order] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, orderId), eq(orders.shopId, id)));
  if (!order) throw notFound("Order");
  const r = await allocateOrder(orderId, "MANUAL_SHOP", { actorId: user.id });
  return ok({ outcome: r.outcome, channel: r.channel, providerCode: r.providerCode, detail: r.detail });
});
