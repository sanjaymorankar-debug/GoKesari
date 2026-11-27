/**
 * docs/flows-v3/wave2.md (flag flow_f16): the shop answers a customer's request to cancel a packed order.
 *   POST { accept: boolean, note? } — agree: the order is cancelled with a full refund (no charge); decline: it
 *   carries on and the customer is told. The owner, staff holding orders.cancel, or operations. 404 while off.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { decideCancelRequest } from "@/server/flows/f16-cancellations";

export const dynamic = "force-dynamic";

const schema = z.object({ accept: z.boolean(), note: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { shopId: true } });
  if (!order) throw notFound("Order");
  const access = await requireShopPermission(order.shopId, "orders.cancel", { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  return ok(await decideCancelRequest(id, access.user, body, { shopStaff: true }));
});
