/** "Price on confirmation" requests to this shop (brief §7). GET ?status=OPEN|ALL. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listShopPriceRequests } from "@/server/puja/storefront";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const { status } = parseQuery(request, z.object({ status: z.enum(["OPEN", "ALL"]).optional() }));
  return ok({ requests: await listShopPriceRequests(id, status ?? "OPEN") });
});
