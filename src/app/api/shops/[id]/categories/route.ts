/**
 * A shop's categories.
 *   GET                 the categories it has (its owner, or staff)
 *   PUT { categoryIds } replace them — at least one (its owner, or staff)
 * Only the category mapping changes; products, stock and orders are untouched.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopCategories, setShopCategories } from "@/server/services/shop-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  const categories = await getShopCategories(id);
  return ok({ categories: categories.map((c) => ({ id: c.id, name: c.name, status: c.status })) });
});

const schema = z.object({
  categoryIds: z.array(z.string().uuid()).min(1, "Please select at least one shop category.").max(60),
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  const { categoryIds } = await parseBody(request, schema);
  const categories = await setShopCategories(id, categoryIds, user);
  return ok({ categories: categories.map((c) => ({ id: c.id, name: c.name, status: c.status })) });
});
