/** Book a slot: { slotId, date: "YYYY-MM-DD" }. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { bookSlot } from "@/server/services/rider-slot-bookings";

export const dynamic = "force-dynamic";

const schema = z.object({
  slotId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-25."),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`rider-slot-book:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) throw notFound("Delivery partner profile");
  const booking = await bookSlot({ partnerId: partner.id, userId: user.id }, body.slotId, body.date);
  return ok({ id: booking.id, slotId: booking.slotId, date: booking.slotDate, status: booking.status }, 201);
});
