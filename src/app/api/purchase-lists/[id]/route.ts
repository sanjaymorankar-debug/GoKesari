/** One purchase list — read (with live prices), rename / change, delete (docs/purchase-lists-2026-10). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { LIST_LIMITS } from "@/lib/purchase-lists";
import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { deletePurchaseList, getPurchaseList, updatePurchaseList } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).max(LIST_LIMITS.nameLength * 2).optional(),
  kind: z.enum(["SHOPPING", "MEDICINE"]).optional(),
  frequency: z.enum(["WEEKLY", "MONTHLY"]).optional(),
  remind: z.boolean().optional(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok(await getPurchaseList(user.id, id));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, updateSchema);
  return ok(await updatePurchaseList(user.id, id, body));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await deletePurchaseList(user.id, id);
  return noContent();
});
