/** Rider Refer & Earn (rule riderReferral): the rider's code, the terms and their referrals. */
import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyReferrals } from "@/server/services/rider-referrals";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");
  return ok(await getMyReferrals(partner.id));
});
