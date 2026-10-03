/** Products a shop sees through its categories. GET ?q=&categoryId=&offset= (owner or staff) */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { assertCanManageShopCategories, listProductsVisibleToShop } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

const schema = z.object({
  q: z.string().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  z.string().uuid().parse(id);
  await assertCanManageShopCategories(id, user);
  const { q, categoryId, offset } = parseQuery(request, schema);
  return ok(await listProductsVisibleToShop(id, { query: q, categoryId, offset, limit: 50 }));
});
