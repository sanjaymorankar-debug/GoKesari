/**
 * POST { mobile, referralCode } → sends a registration code by SMS. The
 * referral code is checked first: an invalid code — or no code while the
 * admin's setting referral_required_shop is MANDATORY — sends nothing.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { sendRegistrationOtp } from "@/server/registration/otp";
import { assertSelfRegistrationOpen, checkJoinReferral, parseMobileOrThrow } from "@/server/registration/service";

export const dynamic = "force-dynamic";

const schema = z.object({ mobile: z.string().trim().min(10).max(16), referralCode: z.string().trim().max(40).nullish() });

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "registration-otp"), { limit: 10, windowMs: 10 * 60_000 });
  await assertSelfRegistrationOpen();
  const input = await parseBody(request, schema);
  const check = await checkJoinReferral(input.referralCode);
  if (!check.ok) throw validationFailed(check.message, { reason: check.reason });
  const mobile = parseMobileOrThrow(input.mobile);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok({ sent: true, ...(await sendRegistrationOtp(mobile.e164, ip)) });
});
