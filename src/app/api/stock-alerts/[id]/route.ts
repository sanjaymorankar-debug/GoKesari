/** Acknowledge a stock alert (its shop's owner, or staff): PATCH { action: "acknowledge" }. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { acknowledgeStockAlert } from "@/server/services/inventory-alerts";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await parseBody(request, z.object({ action: z.literal("acknowledge") }));
  return ok(await acknowledgeStockAlert(id, user));
});
