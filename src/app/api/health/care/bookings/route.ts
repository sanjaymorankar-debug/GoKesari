/**
 * POST — book a home-care visit for a family member (createHealthBooking underneath: no double booking,
 * payment, reminders). Body: careBookingInput (patientId, serviceId, memberId?, mode HOME_VISIT | IN_PERSON,
 * start, instructions?, shareRecords, paymentMode?, addressId? | visitAddress + pin, suggestionId?, sessions?,
 * packageId?, consent: true). → { booking, checkoutUrl, visitId, packageId }
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bookCareVisit } from "@/server/health/care";
import { bodyOf } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-care-book:${user.id}`, RATE_LIMITS.PAYMENT);
  const created = await bookCareVisit(await bodyOf(request), user);
  return ok({ booking: { id: created.booking.id, bookingNumber: created.booking.bookingNumber, status: created.booking.status }, checkoutUrl: created.checkoutUrl, visitId: created.visitId, packageId: created.packageId }, 201);
});
