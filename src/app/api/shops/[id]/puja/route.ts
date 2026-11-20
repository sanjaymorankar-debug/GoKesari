/**
 * Puja Samagri setup for one shop (docs/puja-samagri-2026-11): GET → the categories with
 * product counts, what the shop lists already, the seed stock, whether the type is on.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getPujaSetup, listPujaTypes } from "@/server/puja/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const [setup, types] = await Promise.all([getPujaSetup(id), listPujaTypes(id)]);
  return ok({ ...setup, types });
});
