/**
 * "Request a referral code" (docs/four-features-2026-10, feature 4). Signed in
 * or not. { name, mobile, shopType, area, city, pincode, latitude?, longitude?,
 * accuracyM? } — coordinates only when the person allowed location access.
 * Saved, then emailed to the referrals team. One request per mobile number per
 * rule shopReferral.duplicateWindowHours (429 with the earlier reference).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { createReferralRequest } from "@/server/services/referral-requests";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(120),
  mobile: z.string().max(20),
  shopType: z.string().max(60),
  area: z.string().max(200),
  city: z.string().max(120),
  pincode: z.string().max(10),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  accuracyM: z.number().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "referral-request"), RATE_LIMITS.GRIEVANCE);
  const user = await getCurrentUser();
  const body = await parseBody(request, schema);
  return ok(await createReferralRequest(body, { userId: user?.id ?? null }), 201);
});
