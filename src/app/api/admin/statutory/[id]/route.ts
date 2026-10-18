/** Edit one statutory row, or record the CA's confirmation of it (STATUTORY_MANAGE). */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { statutoryPatchInput, updateStatutoryRate } from "@/server/statutory/rates";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Statutory setting");
  const body = await parseBody(request, statutoryPatchInput);
  return ok(await updateStatutoryRate(id, body, user));
});
