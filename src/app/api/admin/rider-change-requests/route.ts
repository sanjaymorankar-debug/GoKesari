/** F2: rider identity / bank changes waiting for review. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listPendingChangeRequests } from "@/server/services/rider-profile";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  return ok({ requests: await listPendingChangeRequests(user) });
});
