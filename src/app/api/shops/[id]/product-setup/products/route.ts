/**
 * Step 2: the master products of the shop's categories.
 *   GET ?q&category&newOnly&offset      one page
 *   GET ...&ids=1                       the ids of every match not yet in the shop ("Select all")
 *   POST { productIds }                 lists them as Needs Stock
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { assertCanManageShopCategories } from "@/server/services/product-categories";
import { addPickedProducts, listPickerIds, listPickerProducts } from "@/server/services/shop-product-setup";

export const dynamic = "force-dynamic";

const query = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().uuid().optional(),
  newOnly: z.enum(["1"]).optional(),
  ids: z.enum(["1"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await assertCanManageShopCategories(id, user);
  const q = parseQuery(request, query);
  const filters = { query: q.q, categoryId: q.category, newOnly: q.newOnly === "1" };
  if (q.ids) return ok({ ids: await listPickerIds(id, filters) });
  return ok(await listPickerProducts(id, { ...filters, offset: q.offset, limit: 50 }));
});

const body = z.object({ productIds: z.array(z.string().uuid()).min(1).max(50_000) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  const { productIds } = await parseBody(request, body);
  return ok(await addPickedProducts(id, productIds, user));
});
