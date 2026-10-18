/**
 * F3.3.2 (batch-2026-10 WS-B): the signed-in rider's open broadcast offers
 * (first to accept gets the order), plus ones another rider has just taken
 * ("Offer taken"). The dashboard polls this every
 * dispatchBroadcast.riderPollSeconds. Empty while the rule is off.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getRiderBroadcastSettings, listMyBroadcastOffers } from "@/server/services/dispatch-broadcast";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const settings = await getRiderBroadcastSettings();
  if (!settings) return ok({ enabled: false, pollSeconds: null, offers: [] });
  return ok({ enabled: true, pollSeconds: settings.pollSeconds, offers: await listMyBroadcastOffers(user.id) });
});
