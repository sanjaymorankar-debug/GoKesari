/** One product on a purchase list — change its quantity (0 = skip this time) or note, or remove it. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { LIST_LIMITS } from "@/lib/purchase-lists";
import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { removePurchaseListItem, updatePurchaseListItem } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  quantity: z.number().int().min(0).max(LIST_LIMITS.maxQuantity).optional(),
  note: z.string().max(LIST_LIMITS.noteLength * 2).nullish(),
});

type Params = { id: string; itemId: string };

export const PATCH = route(async (request: NextRequest, context: RouteContext<Params>) => {
  const user = await requireUser();
  const { id, itemId } = await context.params;
  const body = await parseBody(request, updateSchema);
  return ok(await updatePurchaseListItem(user.id, id, itemId, body));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<Params>) => {
  const user = await requireUser();
  const { id, itemId } = await context.params;
  await removePurchaseListItem(user.id, id, itemId);
  return noContent();
});
