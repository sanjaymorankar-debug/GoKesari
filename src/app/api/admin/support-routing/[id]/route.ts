/** Switch a help-desk routing rule off (docs/flows-v3/wave1.md; flag flow_f17). Administrators and Support Managers. */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { removeRoutingRule } from "@/server/aftercare/ticket-routing";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: Request, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SUPPORT_QUEUE_MANAGE);
  const { id } = await context.params;
  await removeRoutingRule(id, user);
  return ok({ removed: true });
});
