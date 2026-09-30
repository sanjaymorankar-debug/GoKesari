/**
 * Request a mobile-login code (GS-001).
 *
 * POST { countryCode, mobile, channel: "EMAIL" | "SMS" }
 * Always answers 200 with the same body for known and unknown numbers.
 * Verification happens through Auth.js (`signIn("mobile-otp", ...)`).
 * GET reports which delivery channels are currently available.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { emailMode } from "@/server/email/transport";
import { getProvider } from "@/server/otp/providers";
import { requestLoginOtp } from "@/server/otp/service";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const schema = z.object({
  countryCode: z.string().min(2).max(5),
  mobile: z.string().min(6).max(20),
  channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
});

export const POST = route(async (request: NextRequest) => {
  const rules = await getRule("otp");
  enforceRateLimit(clientKey(request, "otp-request"), {
    limit: rules.maxRequestsPerIpPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await requestLoginOtp({ ...body, ip }));
});

export const GET = route(async () => {
  const rules = await getRule("otp");
  return ok({
    email: emailMode() !== "disabled",
    sms: rules.smsEnabled && Boolean(getProvider("SMS")?.isAvailable()),
    codeLength: rules.length,
    expiryMinutes: rules.expiryMinutes,
  });
});
