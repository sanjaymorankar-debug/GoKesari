/** Lift a suspension: the shop is approved again (SHOP_SUSPEND — operator, admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reactivateShop } from "@/server/services/shop-suspension";

const schema = z.object({ note: z.string().trim().min(3).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_SUSPEND);
  const { id } = await context.params;
  const { note } = await parseBody(request, schema);
  const shop = await reactivateShop(id, note, user);
  return ok({ id: shop.id, status: shop.status });
});
