/**
 * docs/guest-checkout-2026-11: the /track form — find an order without signing in.
 *
 *   { mode: "mobile", reference, last4 }        → { url } (the /track/<token> page)
 *   { mode: "email", reference, email }         → a code to that e-mail if it is the order's; same reply either way
 *   { mode: "email-code", reference, email, code } → { url }
 *
 * Every failed lookup gets the same message. Rate-limited per IP and per reference; lookups audited.
 * 404 unless both guest flags are on.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { featureNotAvailable } from "@/server/services/feature-flags";
import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import {
  isGuestCheckoutOn,
  lookupByMobileDigits,
  requestTrackingCode,
  verifyTrackingCode,
} from "@/server/guest-checkout/tracking";

export const dynamic = "force-dynamic";

const reference = z.string().trim().min(6).max(40);
const schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("mobile"), reference, last4: z.string().trim().min(4).max(8) }),
  z.object({ mode: z.literal("email"), reference, email: z.string().trim().max(254) }),
  z.object({ mode: z.literal("email-code"), reference, email: z.string().trim().max(254), code: z.string().trim().min(4).max(12) }),
]);

/** 10 tries per IP per 10 minutes, 5 per reference per hour: 4 digits cannot be walked. */
const PER_IP = { limit: 10, windowMs: 600_000 };
const PER_REFERENCE = { limit: 5, windowMs: 3_600_000 };

export const POST = route(async (request: NextRequest) => {
  if (!(await isGuestCheckoutOn())) throw featureNotAvailable("guest_checkout_enabled");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  enforceRateLimit(`track-lookup:${ip ?? "unknown"}`, PER_IP);
  const body = await parseBody(request, schema);
  enforceRateLimit(`track-lookup-ref:${body.reference.toUpperCase()}`, PER_REFERENCE);
  if (body.mode === "mobile") return ok(await lookupByMobileDigits({ reference: body.reference, last4: body.last4, ip }));
  if (body.mode === "email") return ok(await requestTrackingCode({ reference: body.reference, email: body.email, ip }));
  return ok(await verifyTrackingCode({ reference: body.reference, email: body.email, code: body.code, ip }));
});
