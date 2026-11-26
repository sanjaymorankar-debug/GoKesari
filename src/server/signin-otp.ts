/**
 * Opening the session after a sign-in code (src/app/signin, the shop
 * registration sign-in card, the Google second-factor page). With the SMS
 * second factor in force for the account (docs/sms-2fa-2026-11) the session
 * is NOT opened here: the caller gets the SMS step's prompt instead.
 */
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import type { User } from "@/server/db/schema";
import { afterEmailFactor, type SecondFactorPrompt } from "@/server/otp/second-factor";
import { createLoginTicket } from "@/server/otp/service";

/** Every sign-in method lands here first: it asks for missing details, then goes home. */
export const AFTER_SIGN_IN = "/onboarding";

export type SignInStepResult = { error?: string; secondFactor?: SecondFactorPrompt } | void;

/** Opens the session for `userId` (a redirect on success). */
export async function openSession(userId: string, redirectTo = AFTER_SIGN_IN): Promise<{ error: string } | void> {
  try {
    await signIn(OTP_TICKET_PROVIDER_ID, { ticket: createLoginTicket(userId), redirectTo });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof AuthError) return { error: "Could not sign you in. Please request a new code." };
    throw error;
  }
}

/** After the first factor: the session, or the SMS step when the account needs it. */
/** `firstFactor`: how the verified code reached the person (docs/dual-auth-2026-11: SMS first → e-mail second). */
export async function continueAfterFirstFactor(user: User, ip: string | null, redirectTo = AFTER_SIGN_IN, firstFactor: "EMAIL" | "SMS" = "EMAIL"): Promise<SignInStepResult> {
  const next = await afterEmailFactor(user, ip, firstFactor);
  if (next.secondFactor) return { secondFactor: next.secondFactor };
  return openSession(user.id, redirectTo);
}
