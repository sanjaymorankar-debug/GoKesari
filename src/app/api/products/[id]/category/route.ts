/**
 * Change a product's category. PATCH { categoryId, keepListingsVisible? }
 * Staff: any product. Shop owner: only their own product still awaiting approval.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { setProductCategory } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

const schema = z.object({ categoryId: z.string().uuid(), keepListingsVisible: z.boolean().default(true) });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const { categoryId, keepListingsVisible } = await parseBody(request, schema);
  return ok(await setProductCategory(id, categoryId, user, { keepListingsVisible }));
});
