/**
 * Google sign-in for the mobile app.
 *
 * Google refuses to sign anyone in from inside an app's WebView, so the app
 * opens Google in the system browser instead and gets the result back through
 * its URL scheme. The browser and the WebView do not share cookies, so the
 * browser hands the app a short code, and the WebView trades that code for its
 * own session.
 *
 *   app        makes a random `verifier`, sends only its SHA-256 (`challenge`)
 *   browser    /mobile-auth/start     → remembers the challenge, signs in with Google
 *   browser    /mobile-auth/complete  → issues a code bound to user + challenge,
 *                                       hands it to `<scheme>://auth-callback`
 *   WebView    /mobile-auth/finish    → code + verifier → normal session
 *
 * This is PKCE (RFC 7636, S256): another app that registers the same URL
 * scheme can intercept the code, but cannot use it without the verifier,
 * which never leaves the app that started the sign-in. The code is signed
 * with AUTH_SECRET, carries no secret itself and expires after two minutes;
 * redeeming it opens the session through the same login ticket the sign-in
 * code (OTP) flow uses, so account status checks are shared.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

export const MOBILE_AUTH_CODE_TTL_MS = 2 * 60_000;

/** Cookie holding `<scheme> <challenge>` in the browser between start and complete. */
export const MOBILE_AUTH_COOKIE = "gk_mobile_auth";
export const MOBILE_AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** base64url of a SHA-256 digest: always 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1 code_verifier. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const USER_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function isValidChallenge(value: string | null | undefined): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

export function challengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function codeMac(userId: string, expires: string, challenge: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET)
    .update(`mobile-auth-code:${userId}.${expires}.${challenge}`)
    .digest("base64url");
}

/** The code the browser hands back to the app once Google sign-in has finished. */
export function createMobileAuthCode(userId: string, challenge: string, now = Date.now()): string {
  if (!isValidChallenge(challenge)) throw new Error("Invalid PKCE challenge.");
  const expires = String(now + MOBILE_AUTH_CODE_TTL_MS);
  return `${userId}.${expires}.${codeMac(userId, expires, challenge)}`;
}

/**
 * The user id the code was issued to, or null when the code is malformed,
 * expired, forged, or the verifier is not the one the sign-in started with.
 */
export function redeemMobileAuthCode(code: string, verifier: string, now = Date.now()): string | null {
  if (!VERIFIER_PATTERN.test(verifier)) return null;
  const parts = code.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  if (!USER_ID_PATTERN.test(userId) || !/^\d+$/.test(expires)) return null;

  const expected = Buffer.from(codeMac(userId, expires, challengeForVerifier(verifier)));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!(Number(expires) > now)) return null;
  return userId;
}
