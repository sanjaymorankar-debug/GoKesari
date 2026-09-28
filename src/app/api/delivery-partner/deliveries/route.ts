/** The signed-in delivery partner's active delivery and recent history. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  getMyActiveDeliveryOrder,
  listMyDeliveryHistory,
  toRiderView,
} from "@/server/services/delivery-assignment";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const [active, history] = await Promise.all([
    getMyActiveDeliveryOrder(user.id),
    listMyDeliveryHistory(user.id),
  ]);
  // Never send the pickup code or customer OTP to the rider.
  return ok({ active: active ? toRiderView(active) : null, history: history.map(toRiderView) });
});
