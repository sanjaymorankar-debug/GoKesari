/** Step 1: add the chosen categories. Removing one stays a confirmed DELETE on /product-categories/{id}. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { chooseCategories } from "@/server/services/shop-product-setup";

export const dynamic = "force-dynamic";

const body = z.object({ categoryIds: z.array(z.string().uuid()).min(1).max(500) });

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  const { categoryIds } = await parseBody(request, body);
  return ok(await chooseCategories(id, categoryIds, user));
});
