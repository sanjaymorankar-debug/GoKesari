/** PUT { label, description?, amountPaise, isActive, sortOrder? } → change a fee plan. An active plan needs an amount. Admin. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { tierSchema, updateTier } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ code: string }>) => {
  const user = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const { code } = await context.params;
  return ok({ tier: await updateTier(code.toUpperCase(), await parseBody(request, tierSchema), user) });
});
