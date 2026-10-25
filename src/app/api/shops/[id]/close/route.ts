/**
 * D-69: close the shop permanently — the owner (or operations, SHOP_SUSPEND).
 * Closing for now is PATCH /api/shops/[id] { ordersPaused }.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { closeShopPermanently } from "@/server/services/shop-closure";

const schema = z.object({ reason: z.string().trim().min(5).max(500), confirmName: z.string().max(200) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_SUSPEND });
  const body = await parseBody(request, schema);
  const shop = await closeShopPermanently(id, body, user);
  return ok({ id: shop.id, status: shop.status, closedAt: shop.closedAt });
});
