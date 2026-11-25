/**
 * Onboarding WP6 (docs/onboarding-waves-2-3-2026-11): GET ?pin=411038 — the approved dealers who cover
 * that PIN code, closest area first, each with its active referral code (src/server/dealers/referral-by-pincode.ts).
 * The dealer's phone only for a signed-in caller. Rate-limited per user (or per address when signed out).
 * Flag onboarding_referral_by_pin_enabled off: 404, as if the route did not exist.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { dealersForPincode } from "@/server/dealers/referral-by-pincode";
import { requireFeature } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.object({ pin: z.string().trim().regex(/^[1-9][0-9]{5}$/, "Enter the 6-digit PIN code.") });

export const GET = route(async (request: NextRequest) => {
  await requireFeature("onboarding_referral_by_pin_enabled");
  const user = await getCurrentUser();
  enforceRateLimit(user ? `referral-by-pin:${user.id}` : clientKey(request, "referral-by-pin"), RATE_LIMITS.REFERRAL_BY_PIN);
  const { pin } = parseQuery(request, schema);
  return ok(await dealersForPincode(pin, { includePhone: Boolean(user) }));
});
