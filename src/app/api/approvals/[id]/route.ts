/** RBAC v2: one approval request with its items and decision history (docs/rbac). */
import type { NextRequest } from "next/server";

import { forbidden } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getApproval } from "@/server/approvals";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const detail = await getApproval(id);
  const r = detail.request;
  const allowed =
    can(actor.role, PERMISSIONS.APPROVAL_VIEW_ANY) ||
    r.requestedBy === actor.id ||
    (can(actor.role, PERMISSIONS.JOURNAL_APPROVE) && (r.checker === "CA" || r.checker === "CA_THEN_ADMIN"));
  if (!allowed) throw forbidden("You cannot see this request.");
  return ok(detail);
});
