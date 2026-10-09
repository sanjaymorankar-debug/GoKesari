/**
 * A customer asks GoKesari for a referral code (docs/four-features-2026-10,
 * the owner's decision of 9 Oct 2026; rule customerSignupReferral). Signed in.
 *   GET  → { needsCode, referral, requests } — whether a code is still needed
 *          before the first order, the code given (if any), and their requests
 *          (with the code once one is issued)
 *   POST { name, mobile, city, pincode, latitude?, longitude?, accuracyM? }
 *        → saved, then emailed to the referrals team (201). One request per
 *          customer or mobile within requestDuplicateWindowHours (429 with the
 *          earlier reference).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createCustomerReferralRequest, listMyCustomerReferralRequests } from "@/server/services/customer-referral-requests";
import { getSignupReferral, needsSignupReferralCode } from "@/server/services/customer-signup-referrals";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(120),
  mobile: z.string().max(20),
  city: z.string().max(120),
  pincode: z.string().max(10),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  accuracyM: z.number().nullish(),
});

export const GET = route(async () => {
  const user = await requireUser();
  const [needsCode, referral, requests] = await Promise.all([
    needsSignupReferralCode(user.id),
    getSignupReferral(user.id),
    listMyCustomerReferralRequests(user.id),
  ]);
  return ok({ needsCode, referral, requests });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`customer-referral-request:${user.id}`, RATE_LIMITS.GRIEVANCE);
  const body = await parseBody(request, schema);
  return ok(await createCustomerReferralRequest(body, user.id), 201);
});
