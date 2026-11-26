/** A new DRAFT version of this plan from any version, or ({asNewPlan: true}) a separate plan to re-scope. */
import type { NextRequest } from "next/server";

import { toPlanRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { clonePlan } from "@/server/services/rider-pay-plans";

import { cloneSchema } from "../../schemas";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  const { asNewPlan } = await parseBody(request, cloneSchema);
  return ok({ plan: toPlanRow(await clonePlan(id, user, asNewPlan ?? false)) }, 201);
});
