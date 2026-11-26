/** Cancel my slot booking: { bookingId } (until the rule's cut-off before the start). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { cancelSlotBooking } from "@/server/services/rider-slot-bookings";

export const dynamic = "force-dynamic";

const schema = z.object({ bookingId: z.string().uuid() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`rider-slot-cancel:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");
  const booking = await cancelSlotBooking({ partnerId: partner.id, userId: user.id }, body.bookingId);
  return ok({ id: booking.id, status: booking.status });
});
