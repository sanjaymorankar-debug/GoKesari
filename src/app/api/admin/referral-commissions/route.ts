/** GET → commission per distributor and per shop (Module 3; recorded only, nothing is paid out by the system). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { commissionReport } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  return ok(await commissionReport());
});
