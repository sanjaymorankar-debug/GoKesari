/** Reorder a scope's photos: PUT { shopProductId?, orderedIds: [...] } — every photo exactly once. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { reorderImages } from "@/server/services/product-images";

const schema = z.object({
  shopProductId: z.string().uuid().nullish(),
  orderedIds: z.array(z.string().uuid()).min(1).max(30),
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  await reorderImages(id, body.shopProductId ?? null, body.orderedIds, user);
  return ok({ saved: true });
});
