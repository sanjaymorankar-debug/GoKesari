/** Ends a surge now. */
import type { NextRequest } from "next/server";

import { toSurgeRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { endSurge } from "@/server/services/rider-pay-plans";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  return ok({ surge: toSurgeRow(await endSurge(id, user)) });
});
