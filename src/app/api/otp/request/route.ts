/**
 * Request a sign-in code (by SMS to a verified mobile, otherwise by email).
 *
 * POST { mobile }          → { status: "SENT_IF_REGISTERED" } for a registered number (its code
 *                            goes out after the response); 404 NOT_FOUND "This mobile number is
 *                            not registered…" for a number no account has (owner, 27-Nov-2026)
 * POST { mobile, email }   → { status: "SENT", maskedEmail }: code sent to that email (sign-up
 *                            with a new number, linked on sign-in if it is free)
 * POST { email }           → { status: "SENT", maskedEmail }: code sent to that email
 * GET reports whether email codes can be sent at all.
 */
import { after, type NextRequest } from "next/server";
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
  return ok(await requestLoginOtp({ mobile: body.mobile, email: body.email, ip, defer: after }));
});

export const GET = route(async () => {
  const rules = await getRule("otp");
  return ok({
    email: emailMode() !== "disabled",
    codeLength: rules.length,
    expiryMinutes: rules.expiryMinutes,
  });
});
