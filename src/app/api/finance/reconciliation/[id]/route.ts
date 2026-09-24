/**
 * Mark a reconciliation record RECONCILED after investigating it, with a
 * note (audited). Admins any record; operators only ORDER / PAYMENT / RIDER.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { OPERATOR_RECONCILIATION_ENTITIES, resolveReconciliationRecord } from "@/server/services/finance";

const schema = z.object({ note: z.string().min(5).max(500) });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireAnyPermission([PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW]);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const allowed = can(user.role, PERMISSIONS.FINANCE_VIEW) ? undefined : OPERATOR_RECONCILIATION_ENTITIES;
  return ok(await resolveReconciliationRecord(id, body.note, user, allowed));
});
