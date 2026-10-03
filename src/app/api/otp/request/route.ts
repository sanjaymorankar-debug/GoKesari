/**
 * Request a login code (mobile or email).
 *
 * POST { countryCode, mobile, channel: "EMAIL" | "SMS" }
 * OR { email, channel: "EMAIL" }
 * Always answers 200 with the same body for known and unknown identifiers.
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

const schemaPhone = z.object({
  countryCode: z.string().min(2).max(5),
  mobile: z.string().min(6).max(20),
  channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
});

const schemaEmail = z.object({
  email: z.string().email(),
  channel: z.enum(["EMAIL", "SMS"]).optional().default("EMAIL"),
});

export const POST = route(async (request: NextRequest) => {
  const rules = await getRule("otp");
  enforceRateLimit(clientKey(request, "otp-request"), {
    limit: rules.maxRequestsPerIpPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return ok({ error: "Invalid JSON" });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Try phone login first
  if (body.mobile && body.countryCode) {
    const phoneResult = schemaPhone.safeParse(body);
    if (phoneResult.success) {
      return ok(await requestLoginOtp({ ...phoneResult.data, ip }));
    }
  }

  // Then try email login
  if (body.email) {
    const emailResult = schemaEmail.safeParse(body);
    if (emailResult.success) {
      return ok(await requestLoginOtp({ email: emailResult.data.email, channel: emailResult.data.channel, ip }));
    }
  }

  return ok({ error: "Either (countryCode and mobile) or email is required" });
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
