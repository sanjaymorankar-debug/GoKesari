/** POST → book a doctor / care provider for a person in my account (records the sharing choice). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createHealthBooking } from "@/server/health/booking";
import { bodyOf } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-book:${user.id}`, RATE_LIMITS.CHECKOUT);
  const created = await createHealthBooking(await bodyOf(request), user);
  return ok({ bookingId: created.booking.id, bookingNumber: created.booking.bookingNumber, status: created.booking.status, checkoutUrl: created.checkoutUrl, tokenNumber: created.tokenNumber }, 201);
});
