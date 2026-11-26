"use server";

/**
 * docs/onboarding-v2-2026-11, login sheet step 2: verify the e-mail. Every way back lands on the page the sheet was
 * opened from with `?sheet=resume`, where the sheet continues (status → mobile code).
 *
 *   - Continue with Google (web and app: the app hands accounts.google.com to the system browser and comes back
 *     through /mobile-auth → /onboarding, which follows the return-to cookie set here);
 *   - the e-mailed sign-in link (web, where a link sender is configured) — opening it verifies the e-mail;
 *   - the e-mailed code (in the app, where the link is hidden today, and where no link sender exists).
 *
 * No referral code is asked here (brief). A new account still needs the Terms tick: the code path reads the
 * sheet's signed tick cookie; Google and the link create the account through Auth.js (createUser: wallet + consent).
 */
import { AuthError } from "next-auth";
import { cookies, headers } from "next/headers";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { isValidEmail } from "@/lib/contact";
import { toClientError } from "@/lib/errors";
import { sheetResumePath } from "@/lib/onboarding-v2-sheet";
import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S } from "@/lib/return-to";
import { signIn } from "@/server/auth";
import { EMAIL_PROVIDER_ID } from "@/server/auth-email";
import { readTermsToken, V2_TERMS_COOKIE } from "@/server/onboarding-v2/customer";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { signInFromForm } from "@/server/signin-form";
import { continueAfterFirstFactor } from "@/server/signin-otp";
import type { SecondFactorPrompt } from "@/server/otp/second-factor";

async function ip(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

async function rememberReturn(path: string): Promise<void> {
  (await cookies()).set(RETURN_TO_COOKIE, path, { path: "/", sameSite: "lax", maxAge: RETURN_TO_MAX_AGE_S, secure: process.env.NODE_ENV === "production" });
}

const OFF = { error: "This sign-in is not available right now." } as const;

export async function sheetGoogleSignIn(returnTo: string): Promise<{ error?: string } | void> {
  if (!(await onboardingV2Enabled())) return OFF;
  const target = sheetResumePath(returnTo);
  await rememberReturn(target);
  await signInFromForm(() => signIn("google", { redirectTo: target }));
}

export async function sheetSendMagicLink(email: string, returnTo: string): Promise<{ error?: string; sent?: true }> {
  if (!(await onboardingV2Enabled())) return OFF;
  const clean = String(email ?? "").trim().toLowerCase();
  if (!isValidEmail(clean)) return { error: "Enter a valid email address, e.g. name@example.com." };
  const target = sheetResumePath(returnTo);
  await rememberReturn(target);
  try {
    await signIn(EMAIL_PROVIDER_ID, { email: clean, redirectTo: target, redirect: false });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof AuthError) return { error: "We could not send the link to this address. Try Continue with Google or another email." };
    throw error;
  }
  return { sent: true };
}

export async function sheetRequestEmailCode(email: string): Promise<{ error?: string; maskedEmail?: string; resendAfterSeconds?: number }> {
  if (!(await onboardingV2Enabled())) return OFF;
  try {
    const result = await requestLoginOtp({ email: String(email ?? ""), ip: await ip() });
    return result.status === "SENT" ? { maskedEmail: result.maskedEmail, resendAfterSeconds: result.resendAfterSeconds } : {};
  } catch (error) {
    return { error: toClientError(error).body.error.message };
  }
}

export async function sheetVerifyEmailCode(email: string, code: string, returnTo: string): Promise<{ error?: string; secondFactor?: true | SecondFactorPrompt } | void> {
  if (!(await onboardingV2Enabled())) return OFF;
  const tick = readTermsToken((await cookies()).get(V2_TERMS_COOKIE)?.value);
  const from = await ip();
  let user: Awaited<ReturnType<typeof verifyLoginOtp>>["user"];
  try {
    ({ user } = await verifyLoginOtp({ email: String(email ?? ""), code: String(code ?? ""), ip: from, acceptedTerms: tick != null }));
  } catch (error) {
    return { error: toClientError(error).body.error.message };
  }
  try {
    // docs/dual-auth-2026-11: after the SMS step (on a new device) the session opens through /onboarding, which
    // follows this return-to cookie back to the cart.
    await rememberReturn(sheetResumePath(returnTo));
    const next = await continueAfterFirstFactor(user, from, sheetResumePath(returnTo));
    // The SMS second factor at sign-in: shown in the sheet itself (docs/dual-auth-2026-11).
    if (next && "secondFactor" in next && next.secondFactor) return { secondFactor: next.secondFactor };
    if (next && "error" in next && next.error) return { error: next.error };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: toClientError(error).body.error.message };
  }
}
