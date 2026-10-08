/**
 * Shop registration form: is this referral code usable? (?code=) — answers
 * valid / not valid only. Signed in, rate-limited like the voucher preview
 * (codes are short, so this is a guessing surface).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { checkReferralCode } from "@/server/services/referral-requests";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(1).max(40) });

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`referral-code-check:${user.id}`, RATE_LIMITS.VOUCHER_PREVIEW);
  const { code } = parseQuery(request, schema);
  return ok(await checkReferralCode(code));
});
