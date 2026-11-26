/** Replays the last 7 or 30 days of delivered orders under this version (stored on a draft; needed to publish). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { simulatePlan } from "@/server/services/rider-pay-plans";

import { simulateSchema } from "../../schemas";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  const { days } = await parseBody(request, simulateSchema);
  return ok({ simulation: await simulatePlan(id, days, user) });
});
