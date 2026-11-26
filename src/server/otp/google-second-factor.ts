/**
 * docs/sms-2fa-2026-11: Google sign-in with the SMS second factor.
 *
 * Auth.js's signIn callback asks `googleSecondFactorGate` before a Google
 * sign-in opens a session. For an account that needs the SMS factor, the
 * session is NOT opened: a 15-minute challenge goes into an httpOnly cookie
 * and the browser is sent to /signin/second-factor, which sends the SMS code
 * and opens the session (through the login ticket) once it is verified. In
 * the app's Google flow (system browser, cookie gk_mobile_auth) that page
 * then continues to /mobile-auth/complete, so the app gets its code as before.
 *
 * A brand-new Google account cannot be created while the factor is in force
 * for customers (there is no account to bind the challenge to yet): the
 * person is asked to create the account with the email code, which asks for
 * the mobile number; Google works afterwards.
 */
import { cookies } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";

import { bootstrapAdminEmails, getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { createSecondFactorChallenge, readSecondFactorChallenge, secondFactorKind, secondFactorRequired, SECOND_FACTOR_TTL_MS } from "./second-factor";

export const SECOND_FACTOR_COOKIE = "gk_2fa_challenge";
export const SECOND_FACTOR_PAGE = "/signin/second-factor";
/** /signin?error=… shown when a new account tries Google while the SMS factor is on. */
export const GOOGLE_SIGN_UP_NEEDS_CODE = "SmsSignUpWithCode";

/** /signin?error=… when Google did not confirm the address (docs/dual-auth-2026-11). */
export const GOOGLE_EMAIL_UNVERIFIED = "GoogleEmailUnverified";

/**
 * true = let Auth.js open the session; a string = where to send the browser instead.
 * `googleEmailVerified`: Google's email_verified claim (undefined for the e-mailed link, which proves the address).
 */
export async function googleSecondFactorGate(rawEmail: string, googleEmailVerified?: boolean): Promise<true | string> {
  const email = rawEmail.toLowerCase().trim();
  const { dualAuthInForce } = await import("@/server/dual-auth/policy");
  const dual = await dualAuthInForce();
  // docs/dual-auth-2026-11: Google counts as the e-mail factor only with email_verified = true.
  if (dual && googleEmailVerified === false) return `/signin?error=${GOOGLE_EMAIL_UNVERIFIED}`;
  const [record] = await db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
  if (!record) {
    if (bootstrapAdminEmails().includes(email)) return true;
    // dual_auth: a new account is created from the verified Google address and asks for the mobile code before
    // anything else (DualVerify gate) — "mobile OTP + Google" for a new customer.
    if (dual) return true;
    const newAccountNeedsIt = await secondFactorRequired({ role: "CUSTOMER", email, emailPlaceholder: false });
    return newAccountNeedsIt ? `/signin?error=${GOOGLE_SIGN_UP_NEEDS_CODE}` : true;
  }
  if (record.status !== "ACTIVE") return true; // refused by the signIn callback's own status check
  if (!(await secondFactorKind(record, "EMAIL"))) return true;
  (await cookies()).set(SECOND_FACTOR_COOKIE, createSecondFactorChallenge(record.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: getEnv().NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SECOND_FACTOR_TTL_MS / 1000),
  });
  return SECOND_FACTOR_PAGE;
}

/** The challenge a Google sign-in left in this browser, if it is still valid. */
export async function pendingGoogleChallenge(): Promise<string | null> {
  const value = (await cookies()).get(SECOND_FACTOR_COOKIE)?.value ?? "";
  return readSecondFactorChallenge(value) ? value : null;
}
