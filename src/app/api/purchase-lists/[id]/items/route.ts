/** Adds a shop's product to a purchase list (docs/purchase-lists-2026-10). Already on it: left as it is. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { LIST_LIMITS } from "@/lib/purchase-lists";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { addPurchaseListItem } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  shopProductId: z.string().uuid(),
  quantity: z.number().int().min(0).max(LIST_LIMITS.maxQuantity).default(1),
  note: z.string().max(LIST_LIMITS.noteLength * 2).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, addSchema);
  const result = await addPurchaseListItem(user.id, id, body);
  return ok(result, result.alreadyOnList ? 200 : 201);
});
