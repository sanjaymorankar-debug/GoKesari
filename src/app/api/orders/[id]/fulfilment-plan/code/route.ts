/**
 * The customer asks for a new delivery code for an order out with the shop's
 * own delivery person (same limits as a rider delivery: rule deliveryOtp).
 * Only the order's own customer; the new code is emailed and returned once.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requestNewOwnDeliveryCode } from "@/server/services/fulfilment-options";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  enforceRateLimit(`own-delivery-code:${user.id}`, RATE_LIMITS.PAYMENT);
  return ok(await requestNewOwnDeliveryCode(id, user));
});
