/** Whether the signed-in customer may pay cash on delivery right now (GS-030). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getCodEligibility } from "@/server/services/cod";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  return ok(await getCodEligibility(user.id));
});
