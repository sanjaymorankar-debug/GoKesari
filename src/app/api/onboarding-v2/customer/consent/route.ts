/**
 * docs/onboarding-v2-2026-11, login sheet step 1: "I agree to the Terms & Conditions and Privacy Policy".
 * Signed in: written at once (user_consents + policy_acceptances, with the channel). A guest: kept in a short-lived
 * signed cookie and written by /api/onboarding-v2/customer/status once the account exists. 404 while the flag is off.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import {
  createTermsToken,
  onboardingV2Enabled,
  recordCheckoutConsent,
  V2_TERMS_COOKIE,
  V2_TERMS_MAX_AGE_S,
} from "@/server/onboarding-v2/customer";
import { formatIstStamp } from "@/server/onboarding-v2/roles";
import { featureNotAvailable } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.object({ accepted: z.literal(true) });

export const POST = route(async (request: NextRequest) => {
  if (!(await onboardingV2Enabled())) throw featureNotAvailable("onboarding_v2");
  enforceRateLimit(clientKey(request, "ov2-consent"), { limit: 20, windowMs: 600_000 });
  await parseBody(request, schema);
  const tick = { version: CURRENT_POLICY_VERSION, acceptedAt: new Date() };
  const userAgent = request.headers.get("user-agent");
  const user = await getCurrentUser();
  if (user) {
    await recordCheckoutConsent(user.id, tick, {
      channel: isMobileAppUserAgent(userAgent) ? "APP" : "WEB",
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent,
    });
  }
  const response = NextResponse.json({ version: tick.version, acceptedAt: tick.acceptedAt.toISOString(), acceptedAtIst: formatIstStamp(tick.acceptedAt), recorded: Boolean(user) });
  if (!user) {
    response.cookies.set(V2_TERMS_COOKIE, createTermsToken(tick), {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: V2_TERMS_MAX_AGE_S,
    });
  }
  return response;
});
