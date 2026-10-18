/** GET — the shops the signed-in Operator (Limited) onboarded, with fee and onboarding status (F8.4.2). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listMyOnboardedShops } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  return ok({ shops: await listMyOnboardedShops(user) });
});
