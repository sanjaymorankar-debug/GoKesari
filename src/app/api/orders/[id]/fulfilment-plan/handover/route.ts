/**
 * Handing over a pickup / own-delivery order (docs/four-features-2026-10).
 * The order's shop owner, or operations.
 *
 *   { action: "pickup", code, cashCollected? }      customer collects at the shop (pickup code)
 *   { action: "out_for_delivery" }                   own delivery leaves (customer is emailed a code)
 *   { action: "deliver", code, cashCollected? }      own delivery completed (customer's delivery code)
 *   { action: "confirm", note, cashCollected? }      operations only: confirm without a code (lockout)
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
import { orders } from "@/server/db/schema";
import {
  completeOwnDelivery,
  completePickup,
  confirmFulfilmentByOperator,
  startOwnDelivery,
} from "@/server/services/fulfilment-options";

const code = z.string().trim().max(12);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pickup"), code, cashCollected: z.boolean().optional() }),
  z.object({ action: z.literal("out_for_delivery") }),
  z.object({ action: z.literal("deliver"), code, cashCollected: z.boolean().optional() }),
  z.object({ action: z.literal("confirm"), note: z.string().max(300), cashCollected: z.boolean().optional() }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { id: true, shopId: true } });
  if (!order) throw notFound("Order");
  const { user } = await requireShopAccess(order.shopId, { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  enforceRateLimit(`fulfilment-handover:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);

  switch (body.action) {
    case "pickup":
      return ok(await completePickup(id, body, user));
    case "out_for_delivery":
      return ok(await startOwnDelivery(id, user));
    case "deliver":
      return ok(await completeOwnDelivery(id, body, user));
    case "confirm":
      return ok(await confirmFulfilmentByOperator(id, body, user));
  }
});
