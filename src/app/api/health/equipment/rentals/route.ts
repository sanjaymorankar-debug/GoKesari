/**
 * GET — my equipment rentals. POST rentalInput — rent an item (listingId, periodUnit, periodCount, startDate,
 * quantity, addressId, patientId?, suggestionId?, prescriptionId?, acceptTerms: true); totals are worked out
 * on the server; online payment only. → { rental, checkoutUrl }
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { bodyOf } from "@/server/health/http";
import { createRental, customerRentals } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  await requireHealthEnabled();
  return ok({ rentals: await customerRentals(user) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-rent:${user.id}`, RATE_LIMITS.PAYMENT);
  const r = await createRental(await bodyOf(request), user);
  return ok({ rental: { id: r.rental.id, rentalNumber: r.rental.rentalNumber, totalPaise: r.rental.totalPaise }, checkoutUrl: r.checkoutUrl }, 201);
});
