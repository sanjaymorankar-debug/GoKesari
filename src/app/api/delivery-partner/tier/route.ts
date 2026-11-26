/** Rider tier badge (rule riderTiers): the tier, last-7-day metrics and what the next tier needs. */
import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRiderTier } from "@/server/services/rider-tiers";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");
  const view = await getRiderTier(partner.id);
  return ok({ enabled: view.enabled, tier: view.tier, metrics: view.metrics, next: view.next, tiers: view.tiers });
});
