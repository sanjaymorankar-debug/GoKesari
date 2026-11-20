/**
 * Removed products and restore (brief §5d). GET → the shop's removed listings (newest first);
 * POST { listingIds } → brings them back with their price, stock and order history.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRemovedListings, restoreListings } from "@/server/puja/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  return ok({ listings: await listRemovedListings(id) });
});

const schema = z.object({ listingIds: z.array(z.string().uuid()).min(1, "Choose at least one product.").max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const { listingIds } = await parseBody(request, schema);
  return ok(await restoreListings(id, listingIds, user as never));
});
