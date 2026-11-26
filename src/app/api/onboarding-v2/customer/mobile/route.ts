/**
 * docs/onboarding-v2-2026-11, login sheet step 3: the mobile number by SMS code.
 *   { action: "send", mobile }          → CODE_SENT, or SAVED_UNVERIFIED where no SMS can be sent and rule
 *                                         onboardingV2.mobileOtpFallbackWhenNoSms is on (409 when it is off)
 *   { action: "verify", mobile, code }  → the number saved as verified; the wallet ensured; the new status
 * Signed in only (step 2 opened the session). 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { confirmMobileVerification, onboardingV2Enabled, startMobileVerification } from "@/server/onboarding-v2/customer";
import { featureNotAvailable } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), mobile: z.string().trim().min(10).max(16) }),
  z.object({ action: z.literal("verify"), mobile: z.string().trim().min(10).max(16), code: z.string().trim().regex(/^\d{4,8}$/) }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  if (!(await onboardingV2Enabled())) throw featureNotAvailable("onboarding_v2");
  enforceRateLimit(`ov2-mobile:${user.id}`, { limit: 20, windowMs: 600_000 });
  enforceRateLimit(clientKey(request, "ov2-mobile"), { limit: 40, windowMs: 600_000 });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (body.action === "send") return ok(await startMobileVerification(user.id, body.mobile, ip));
  return ok(await confirmMobileVerification(user.id, body.mobile, body.code, ip));
});
