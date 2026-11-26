/**
 * Terms & Privacy tick for Google and e-mail-link sign-ups (docs/flows-v3/wave1.md, F1 step 1; flag flow_f1).
 *
 * The /signin page's buttons are enabled only after the "I agree" box is ticked, and they submit acceptedTerms=1.
 * While flow_f1 is on:
 *   - the Google / e-mail-link server action refuses to start without acceptedTerms=1 and keeps the tick in the
 *     same short-lived signed cookie onboarding v2 uses (gk_ov2_terms: policy version + time + HMAC, nothing
 *     personal);
 *   - when Auth.js creates the account (auth.ts createUser) the tick from that cookie is written as the consent
 *     record (user_consents source SIGNIN_PAGE + policy_acceptances for terms and privacy policy, with channel,
 *     address and browser) at the time it was given.
 * A sign-up finished on another device (the e-mailed link opened elsewhere) has no cookie there: the consent is
 * recorded as before, without the signed time stamp. Off: nothing here runs; auth.ts records consent as before.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { createTermsToken, readTermsToken, recordCheckoutConsent, V2_TERMS_COOKIE, V2_TERMS_MAX_AGE_S } from "@/server/onboarding-v2/customer";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const SIGNIN_CONSENT_SOURCE = "SIGNIN_PAGE";

export async function signUpTermsRecordOn(): Promise<boolean> {
  return isFeatureEnabled("flow_f1").catch(() => false);
}

/**
 * In the /signin server actions, before signIn(): with flow_f1 on, a form without the tick goes back to /signin
 * (the button cannot be pressed without it); with it, the signed tick is kept for createUser.
 */
export async function rememberSignUpTermsTick(formData: FormData | null | undefined): Promise<void> {
  if (!(await signUpTermsRecordOn())) return;
  if (formData?.get("acceptedTerms") !== "1") redirect("/signin?error=SignInFailed");
  const store = await cookies();
  const secure = (await headers()).get("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production";
  store.set(V2_TERMS_COOKIE, createTermsToken({ version: CURRENT_POLICY_VERSION, acceptedAt: new Date() }), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: V2_TERMS_MAX_AGE_S,
  });
}

/**
 * In auth.ts createUser: writes the signed tick as the new account's consent record. True when it was written;
 * false (flag off, no valid tick on this device, or an error) and the caller records consent as before.
 */
export async function recordSignUpTermsFromCookie(userId: string): Promise<boolean> {
  try {
    if (!(await signUpTermsRecordOn())) return false;
    const store = await cookies();
    const tick = readTermsToken(store.get(V2_TERMS_COOKIE)?.value);
    if (!tick) return false;
    const h = await headers();
    const userAgent = h.get("user-agent");
    await recordCheckoutConsent(
      userId,
      tick,
      {
        channel: isMobileAppUserAgent(userAgent) ? "APP" : "WEB",
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        userAgent,
      },
      SIGNIN_CONSENT_SOURCE,
    );
    try {
      store.delete(V2_TERMS_COOKIE);
    } catch {
      // Not every context may change cookies; the token expires on its own.
    }
    return true;
  } catch (error) {
    console.error("[auth] sign-up terms record failed; recorded the usual way", error);
    return false;
  }
}
