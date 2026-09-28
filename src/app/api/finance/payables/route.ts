/** What each shop and rider is currently owed (not yet batched). FINANCE_VIEW. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getPayablesOverview } from "@/server/services/finance";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await getPayablesOverview());
});
