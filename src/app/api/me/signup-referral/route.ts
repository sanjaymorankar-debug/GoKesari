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
import { referralAfterFirstOrderIds } from "@/server/flows/f2-order";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(1, "Enter a referral code.").max(40) });

export const GET = route(async () => {
  const user = await requireUser();
  const [referral, ask, afterFirstOrder] = await Promise.all([getSignupReferral(user.id), shouldAskSignupReferral(user.id), referralAfterFirstOrderIds(user.id)]);
  // docs/flows-v3/wave2.md (flag flow_f2): also asked (optional) after the first order is paid.
  return ok({ referral, ask: ask || afterFirstOrder.length > 0 });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  // Codes are short, so this is a guessing surface: limited like the voucher preview.
  enforceRateLimit(`signup-referral:${user.id}`, RATE_LIMITS.VOUCHER_PREVIEW);
  const body = await parseBody(request, schema);
  // docs/flows-v3/wave2.md (flag flow_f2): the first checkout's orders do not count as "already ordered".
  const firstOrderIds = await referralAfterFirstOrderIds(user.id);
  return ok(await applySignupReferralCode(user.id, body.code, user, firstOrderIds.length > 0 ? { firstOrderIds } : {}));
});
