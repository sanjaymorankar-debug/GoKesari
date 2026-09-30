/** Lifecycle history of a subscription (owner, or SUBSCRIPTION_MANAGE_ANY). */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listSubscriptionEvents } from "@/server/services/subscriptions";

export const GET = route(async (_request: Request, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireSubscriptionAccess(id, { anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY });
  return ok(await listSubscriptionEvents(id));
});
