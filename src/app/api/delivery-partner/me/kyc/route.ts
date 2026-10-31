/** Gig worker flow (feature 2): the partner's own PAN and Aadhaar check status — masked numbers only. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyRiderKyc } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok(await getMyRiderKyc(user.id));
});
