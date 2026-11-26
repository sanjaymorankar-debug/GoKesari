/**
 * docs/onboarding-v2-2026-11: where the signed-in customer stands in the login sheet (CONSENT / EMAIL / MOBILE /
 * DONE). A Terms tick the guest gave before signing in (signed cookie) is written here first — once, then the
 * cookie is cleared. POST because of that write. 404 while the flag is off.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import {
  customerLoginStatus,
  onboardingV2Enabled,
  readTermsToken,
  recordCheckoutConsent,
  V2_TERMS_COOKIE,
} from "@/server/onboarding-v2/customer";
import { featureNotAvailable } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  if (!(await onboardingV2Enabled())) throw featureNotAvailable("onboarding_v2");
  const tick = readTermsToken(request.cookies.get(V2_TERMS_COOKIE)?.value);
  if (tick) {
    const userAgent = request.headers.get("user-agent");
    await recordCheckoutConsent(user.id, tick, {
      channel: isMobileAppUserAgent(userAgent) ? "APP" : "WEB",
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent,
    });
  }
  const response = NextResponse.json(await customerLoginStatus(user.id));
  if (request.cookies.get(V2_TERMS_COOKIE)) response.cookies.delete(V2_TERMS_COOKIE);
  return response;
});
