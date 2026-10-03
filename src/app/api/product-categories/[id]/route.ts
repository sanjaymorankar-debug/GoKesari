/**
 * One category.
 *   PATCH { name?, description?, isActive?, department? }
 *   DELETE ?keepListingsVisible=0   remove: products → General, unlinked from every shop
 * Staff may change any category; a shop owner only one they created that no
 * other owner's shop carries. General can never be removed, renamed or deactivated.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { removeProductCategory, updateProductCategory } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

const MANAGE = [PERMISSIONS.PRODUCT_CATEGORY_MANAGE_ANY, PERMISSIONS.PRODUCT_CATEGORY_MANAGE_OWN];

const schema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(300).nullish(),
  isActive: z.boolean().optional(),
  department: z.enum(SHOP_TYPE_KEYS).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireAnyPermission(MANAGE);
  const { id } = await context.params;
  z.string().uuid().parse(id);
  return ok(await updateProductCategory(id, await parseBody(request, schema), user));
});

export const DELETE = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireAnyPermission(MANAGE);
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const keepListingsVisible = new URL(request.url).searchParams.get("keepListingsVisible") !== "0";
  return ok(await removeProductCategory(id, user, { keepListingsVisible }));
});
