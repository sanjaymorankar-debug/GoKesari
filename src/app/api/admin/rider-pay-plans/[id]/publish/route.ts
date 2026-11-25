/**
 * Publishes a draft (needs a current simulator run and a note). From effectiveFrom (default now) it
 * prices NEW offers only; quotes already locked and earnings already paid never change.
 */
import type { NextRequest } from "next/server";

import { toPlanRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { publishPlan } from "@/server/services/rider-pay-plans";

import { publishSchema } from "../../schemas";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, publishSchema);
  const plan = await publishPlan(id, { note: body.note, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null }, user);
  return ok({ plan: toPlanRow(plan) });
});
