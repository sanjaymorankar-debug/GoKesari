/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 1 — identity, for a v2 registration (flag onboarding_v2):
 *   { action: "terms", accept: true }                    the Terms tick (version + time)
 *   { action: "email-code", email? } / { action: "email-verify", email?, code }   confirm (or add) the e-mail
 *   { action: "mobile-code", mobile } / { action: "mobile-verify", mobile, code } the mobile code by SMS; with no SMS
 *     and rule onboardingV2.mobileOtpFallbackWhenNoSms on, "mobile-code" saves the mobile unverified (DEFAULT #8).
 * Answers with the whole wizard (plus `sent` for the code requests).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import {
  acceptV2Terms,
  confirmV2EmailCode,
  confirmV2MobileCode,
  requestV2EmailCode,
  requestV2MobileCode,
} from "@/server/onboarding-v2/shop-flow";
import { getWizardDraft } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const code = z.string().trim().regex(/^\d{4,8}$/, "Enter the code.");
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("terms"), accept: z.literal(true, { message: "Please accept the Terms." }) }),
  z.object({ action: z.literal("email-code"), email: z.string().trim().email().max(254).nullish() }),
  z.object({ action: z.literal("email-verify"), email: z.string().trim().email().max(254).nullish(), code }),
  z.object({ action: z.literal("mobile-code"), mobile: z.string().trim().min(10).max(16) }),
  z.object({ action: z.literal("mobile-verify"), mobile: z.string().trim().min(10).max(16), code }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  switch (body.action) {
    case "terms":
      return ok(await acceptV2Terms(user, { accept: body.accept, ip, userAgent: request.headers.get("user-agent") }));
    case "email-code": {
      const sent = await requestV2EmailCode(user, { email: body.email ?? null, ip });
      return ok({ ...(await getWizardDraft(user)), sent: true, resendAfterSeconds: sent.resendAfterSeconds });
    }
    case "email-verify":
      return ok(await confirmV2EmailCode(user, { email: body.email ?? null, code: body.code, ip }));
    case "mobile-code": {
      const { sent, view } = await requestV2MobileCode(user, { mobile: body.mobile, ip });
      return ok({ ...view, sent });
    }
    case "mobile-verify":
      return ok(await confirmV2MobileCode(user, { mobile: body.mobile, code: body.code, ip }));
  }
});
