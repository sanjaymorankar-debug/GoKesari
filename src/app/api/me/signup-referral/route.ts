/**
 * Referral code at customer registration (docs/four-features-2026-10, rule customerSignupReferral).
 *   GET  → the code this customer joined with (or null), and whether it is still asked for
 *   POST { code } → check it (a code GoKesari issued, or a friend's) and record it
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { applySignupReferralCode, getSignupReferral, shouldAskSignupReferral } from "@/server/services/customer-signup-referrals";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(1, "Enter a referral code.").max(40) });

export const GET = route(async () => {
  const user = await requireUser();
  const [referral, ask] = await Promise.all([getSignupReferral(user.id), shouldAskSignupReferral(user.id)]);
  return ok({ referral, ask });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  // Codes are short, so this is a guessing surface: limited like the voucher preview.
  enforceRateLimit(`signup-referral:${user.id}`, RATE_LIMITS.VOUCHER_PREVIEW);
  const body = await parseBody(request, schema);
  return ok(await applySignupReferralCode(user.id, body.code, user));
});
