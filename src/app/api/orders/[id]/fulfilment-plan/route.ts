/**
 * Fulfilment options (docs/four-features-2026-10, feature 1). The order's shop
 * owner, or operations (ORDER_UPDATE_STATUS_ANY).
 *
 *   GET   → the plan, and the time slots that can be chosen now
 *   POST  { option, slotKey, staffId?, markReady? }
 *         option: PICKUP | SHOP_DELIVERY | GOKESARI_PARTNER
 *         markReady: mark a PREPARING order ready with this plan (one step)
 *         Without markReady: set or change the plan of an ACCEPTED, PREPARING,
 *         READY or ASSIGNED order (until collected / out for delivery / picked up).
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { FULFILMENT_OPTIONS, orders } from "@/server/db/schema";
import { getShopFulfilmentViews, planFulfilment, plannerOptions } from "@/server/services/fulfilment-options";

export const dynamic = "force-dynamic";

const schema = z.object({
  option: z.enum(FULFILMENT_OPTIONS),
  slotKey: z.string().regex(/^\d{4}-\d{2}-\d{2}@\d{2}:\d{2}$/, "Choose a time slot."),
  staffId: z.string().uuid().nullish(),
  markReady: z.boolean().optional(),
});

async function access(id: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { id: true, shopId: true } });
  if (!order) throw notFound("Order");
  return requireShopAccess(order.shopId, { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
}

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await access(id);
  const [views, options] = await Promise.all([getShopFulfilmentViews([id]), plannerOptions()]);
  return ok({ plan: views.get(id) ?? null, ...options });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await access(id);
  enforceRateLimit(`fulfilment-plan:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const result = await planFulfilment(id, body, user);
  const views = await getShopFulfilmentViews([id]);
  return ok({ order: result.order, plan: views.get(id) ?? null });
});
