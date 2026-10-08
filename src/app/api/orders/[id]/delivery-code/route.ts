/**
 * The customer asks for a new delivery code for their order while it is on
 * the way (docs/shop-wallet-delivery-otp-2026-10). Only the order's own
 * customer; rate-limited by rule deliveryOtp (resendCooldownSeconds,
 * maxResends), enforced in the database update itself. The previous code stops
 * working. The new code is emailed and returned once here for the order page
 * to show — it is never stored, only its hash.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requestNewDeliveryCode } from "@/server/services/delivery-otp";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.ORDER_VIEW_OWN);
  enforceRateLimit(`delivery-code:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  return ok(await requestNewDeliveryCode(id, user));
});
