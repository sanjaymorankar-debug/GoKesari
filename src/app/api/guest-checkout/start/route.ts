/**
 * docs/guest-checkout-2026-11: guest checkout, step 1 — sends the one-time code(s) for the contact
 * details given at the cart (e-mail always; SMS too where SMS is set up). Creates nothing.
 * 404 unless guest_cart_enabled and guest_checkout_enabled are both on. Rate-limited per IP here,
 * and per e-mail / IP in the database by the OTP service.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { guestStartSchema, startGuestCheckout } from "@/server/guest-checkout/service";

export const dynamic = "force-dynamic";

const clientIp = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

export const POST = route(async (request: NextRequest) => {
  const ip = clientIp(request);
  enforceRateLimit(`guest-checkout-start:${ip ?? "unknown"}`, RATE_LIMITS.GRIEVANCE);
  const body = await parseBody(request, guestStartSchema);
  return ok(await startGuestCheckout(body, ip));
});
