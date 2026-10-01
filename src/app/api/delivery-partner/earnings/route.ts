/** The signed-in delivery partner's earnings summary and statement. */
import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  getPartnerEarningsSummary,
  listEarningLines,
  listPartnerEarnings,
} from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");

  const [summary, statement] = await Promise.all([
    getPartnerEarningsSummary(partner.id),
    listPartnerEarnings(partner.id),
  ]);
  // Every earning comes with the lines it is made of (base, distance, incentives, deductions).
  const lines = await listEarningLines(statement.map((e) => e.id));
  return ok({
    summary,
    statement: statement.map((e) => ({ ...e, lines: lines.filter((l) => l.earningId === e.id) })),
  });
});
