/**
 * Rider App v2 — the signed-in rider's earnings for one Mon–Sun week (IST).
 * GET ?start=YYYY-MM-DD (any day of the week; default this week) → RiderEarningsWeek:
 * week window, total, seven days, chips (trip / incentives / tips / deductions),
 * per-order lines with "Quote ₹X · Final ₹Y", COD cash in hand (apart) and recent payouts.
 */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRiderEarningsWeek } from "@/server/services/rider-earnings-week";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");
  return ok(await getRiderEarningsWeek(partner.id, request.nextUrl.searchParams.get("start")));
});
