/**
 * One category on one shop.
 *   GET      how many of the shop's listings would pause if it were removed
 *   DELETE   remove it — listings pause, nothing is deleted; orders untouched
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import {
  assertCanManageShopCategories,
  countShopListingsInCategory,
  removeCategoryFromShop,
} from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

type Params = RouteContext<{ id: string; categoryId: string }>;

async function parse(context: Params) {
  const { id, categoryId } = await context.params;
  return { id: z.string().uuid().parse(id), categoryId: z.string().uuid().parse(categoryId) };
}

export const GET = route(async (_request: NextRequest, context: Params) => {
  const user = await requireUser();
  const { id, categoryId } = await parse(context);
  await assertCanManageShopCategories(id, user);
  return ok({ pausedListings: await countShopListingsInCategory(id, categoryId) });
});

export const DELETE = route(async (_request: NextRequest, context: Params) => {
  const user = await requireUser();
  const { id, categoryId } = await parse(context);
  return ok(await removeCategoryFromShop(id, categoryId, user));
});
