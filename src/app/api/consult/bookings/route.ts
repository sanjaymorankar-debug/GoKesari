/**
 * Consultant bookings of the signed-in customer (docs/consult-booking-2026-11).
 * GET → { upcoming, past }
 * POST { serviceId, memberId|null, mode, start, attendees, visitorName, visitorPhone, note, visitAddress,
 *        paymentMode: ONLINE|PAY_AT_VISIT, consent: true } → { booking, checkoutUrl } (checkoutUrl: pay now; the time is held)
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createBooking } from "@/server/consult/bookings";
import { customerBookings } from "@/server/consult/views";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await customerBookings(user.id));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`consult-book:${user.id}`, RATE_LIMITS.CHECKOUT);
  const body = await request.json().catch(() => ({}));
  const created = await createBooking(body, user);
  return ok({ booking: { id: created.booking.id, bookingNumber: created.booking.bookingNumber, status: created.booking.status }, checkoutUrl: created.checkoutUrl, intentId: created.intentId }, 201);
});
