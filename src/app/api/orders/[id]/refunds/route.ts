/**
 * F6.2.3 (batch-2026-10 WS-C): the order's refunds with their timelines —
 * the buyer, the shop and support only.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getOrderRefundsFor } from "@/server/aftercare/order-view";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  return ok({ refunds: await getOrderRefundsFor(id, user) });
});
