/**
 * The product categories a shop carries; the shop sees every product in them.
 *   GET                    its categories (owner or staff)
 *   POST { categoryId }    add one (owner of this shop, operator, admin) and
 *                          list its products in the shop's inventory
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import {
  addCategoryToShop,
  assertCanManageShopCategories,
  listShopProductCategories,
} from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  z.string().uuid().parse(id);
  await assertCanManageShopCategories(id, user);
  return ok({ categories: await listShopProductCategories(id) });
});

const schema = z.object({ categoryId: z.string().uuid() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const { categoryId } = await parseBody(request, schema);
  // One transaction: the category and the listings it creates land together.
  const result = await db.transaction((tx) => addCategoryToShop(id, categoryId, user, {}, tx));
  return ok(result, result.added ? 201 : 200);
});
