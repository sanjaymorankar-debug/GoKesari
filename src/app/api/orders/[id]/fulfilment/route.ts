/**
 * Shop fulfilment actions on one order (Vertical Slice 3 — GS-034/035/036).
 * The owner of the order's shop, or anyone with ORDER_UPDATE_STATUS_ANY.
 *
 *   { action: "accept" }
 *   { action: "reject", reason }
 *   { action: "start" }                                  ACCEPTED → PREPARING
 *   { action: "pick", itemId }
 *   { action: "substitute", itemId, substituteShopProductId, note? }
 *   { action: "remove", itemId, reason }                  refunds the line
 *   { action: "ready" }                                    packed → READY → rider dispatch
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import {
  acceptOrder,
  markOrderReady,
  pickItem,
  proposeSubstitution,
  rejectOrder,
  removeItem,
  startPicking,
} from "@/server/services/fulfilment";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("reject"), reason: z.string().min(3).max(300) }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("pick"), itemId: z.string().uuid() }),
  z.object({
    action: z.literal("substitute"),
    itemId: z.string().uuid(),
    substituteShopProductId: z.string().uuid(),
    note: z.string().max(300).optional(),
  }),
  z.object({ action: z.literal("remove"), itemId: z.string().uuid(), reason: z.string().max(300).default("Unavailable") }),
  z.object({ action: z.literal("ready") }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const body = await parseBody(request, schema);

  const order = await db.query.orders.findFirst({
    where: eq(orders.id, id),
    columns: { id: true, shopId: true },
  });
  if (!order) throw notFound("Order");
  const { user } = await requireShopAccess(order.shopId, {
    anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY,
  });

  switch (body.action) {
    case "accept":
      return ok(await acceptOrder(id, user));
    case "reject":
      return ok(await rejectOrder(id, user, body.reason));
    case "start":
      return ok(await startPicking(id, user));
    case "pick":
      await pickItem(id, body.itemId, user);
      return ok({ ok: true });
    case "substitute":
      await proposeSubstitution(id, body.itemId, body.substituteShopProductId, user, body.note);
      return ok({ ok: true });
    case "remove":
      await removeItem(id, body.itemId, user, body.reason);
      return ok({ ok: true });
    case "ready":
      return ok(await markOrderReady(id, user));
  }
});
