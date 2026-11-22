/** One saved wishlist: read, edit (name / all items), delete. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { deleteWishlist, getWishlist, itemInputSchema, updateWishlist } from "@/server/services/smart-list/wishlist";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ name: z.string().max(80).optional(), items: z.array(itemInputSchema).max(100).optional() });

export const GET = route(async (_r: Request, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await getWishlist(user.id, (await context.params).id));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await updateWishlist(user.id, (await context.params).id, await parseBody(request, patchSchema));
  return ok(await getWishlist(user.id, (await context.params).id));
});

export const DELETE = route(async (_r: Request, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await deleteWishlist(user.id, (await context.params).id);
  return noContent();
});
