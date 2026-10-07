/**
 * Category master.
 *   GET ?q=&all=1        categories with product and shop counts (all=1 includes inactive)
 *   GET ?selectable=1    live, active categories for pickers (General first)
 *   POST { name, description?, department? }   add a category (shop owner, operator, admin)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  createProductCategory,
  listCategoryMaster,
  listSelectableCategories,
} from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.CATALOGUE_BROWSE);
  const p = new URL(request.url).searchParams;
  if (p.get("selectable") === "1") return ok({ categories: await listSelectableCategories() });
  return ok({
    categories: await listCategoryMaster(user, { query: p.get("q") ?? undefined, includeInactive: p.get("all") === "1" }),
  });
});

const schema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).nullish(),
  department: z.enum(SHOP_TYPE_KEYS).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_CATEGORY_CREATE);
  return ok(await createProductCategory(await parseBody(request, schema), user), 201);
});
