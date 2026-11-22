/** RBAC v2 Phase 3: financial periods (Accountant and CA read; the CA closes and reopens). */
import { ok, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listPeriods } from "@/server/rbac-accounting/journals";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.FIN_PERIOD_CLOSE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  return ok(await listPeriods());
});
