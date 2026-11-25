"use server";

/**
 * docs/sms-2fa-2026-11: the SMS step of sign-in, as server functions the
 * sign-in form (a client component) calls. The challenge proves the emailed
 * code (or Google) was verified for this user; the session opens only after
 * the SMS code is verified too.
 */
import { cookies, headers } from "next/headers";

import { toClientError } from "@/lib/errors";
import { MOBILE_AUTH_COOKIE } from "@/server/mobile-auth";
import { SECOND_FACTOR_COOKIE } from "@/server/otp/google-second-factor";
import { sendSecondFactorCode, verifySecondFactorCode } from "@/server/otp/second-factor";
import { AFTER_SIGN_IN, openSession } from "@/server/signin-otp";

async function clientIp(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

function failure(error: unknown): { error: string; needsPhone?: boolean } {
  const body = toClientError(error).body.error;
  const details = body.details as { needsPhone?: boolean } | undefined;
  return { error: body.message, ...(details?.needsPhone ? { needsPhone: true } : {}) };
}

export async function sendSignInSmsCode(input: { challenge: string; mobile: string | null }): Promise<
  { maskedPhone: string; resendAfterSeconds: number; expiryMinutes: number; error?: undefined } | { error: string; needsPhone?: boolean }
> {
  try {
    return await sendSecondFactorCode({ challenge: String(input?.challenge ?? ""), mobile: input?.mobile ?? null, ip: await clientIp() });
  } catch (error) {
    return failure(error);
  }
}

export async function verifySignInSmsCode(input: { challenge: string; mobile: string | null; code: string }): Promise<{ error: string } | void> {
  let userId: string;
  try {
    const user = await verifySecondFactorCode({
      challenge: String(input?.challenge ?? ""),
      mobile: input?.mobile ?? null,
      code: String(input?.code ?? ""),
      ip: await clientIp(),
    });
    userId = user.id;
  } catch (error) {
    return failure(error);
  }
  // The Google / emailed-link path (challenge in the cookie): drop it, and in the app's Google flow
  // (system browser) continue to /mobile-auth/complete, which hands the app its code.
  const jar = await cookies();
  let redirectTo = AFTER_SIGN_IN;
  if (jar.get(SECOND_FACTOR_COOKIE)?.value === input.challenge) {
    jar.delete(SECOND_FACTOR_COOKIE);
    if (jar.get(MOBILE_AUTH_COOKIE)?.value) redirectTo = "/mobile-auth/complete";
  }
  return openSession(userId, redirectTo);
}
