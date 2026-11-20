/**
 * The puja master catalogue as this shop sees it (docs/puja-samagri-2026-11, brief §5b):
 * GET ?categoryId&typeId&festival&kind=loose|packed&q&notListed=1&limit&offset.
 * q matches English, Hindi and Marathi names and synonyms. Each item says whether the
 * shop lists it (LISTED) or removed it (REMOVED).
 */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { catalogueQuerySchema } from "@/server/puja/route-helpers";
import { browsePujaCatalogue } from "@/server/puja/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const query = parseQuery(request, catalogueQuerySchema);
  return ok(await browsePujaCatalogue({ ...query, includeRetired: false, taxToVerify: false, shopId: id }));
});
