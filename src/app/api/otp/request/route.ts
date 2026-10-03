/**
 * Request a sign-in code. Codes are always emailed.
 *
 * POST { mobile }          → { status: "SENT", maskedEmail } when the number is registered,
 *                            { status: "EMAIL_REQUIRED" } when it is not
 * POST { mobile, email }   → unregistered number: code sent to that email
 * POST { email }           → code sent to that email
 * GET reports whether email codes can be sent at all.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { emailMode } from "@/server/email/transport";
import { requestLoginOtp } from "@/server/otp/service";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    mobile: z.string().trim().max(20).nullish(),
    email: z.string().trim().max(254).nullish(),
  })
  .refine((b) => Boolean(b.mobile || b.email), { message: "Enter your mobile number or email address." });

export const POST = route(async (request: NextRequest) => {
  const rules = await getRule("otp");
  enforceRateLimit(clientKey(request, "otp-request"), {
    limit: rules.maxRequestsPerIpPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await requestLoginOtp({ mobile: body.mobile, email: body.email, ip }));
});

export const GET = route(async () => {
  const rules = await getRule("otp");
  return ok({
    email: emailMode() !== "disabled",
    codeLength: rules.length,
    expiryMinutes: rules.expiryMinutes,
  });
});
