/**
 * Aadhaar through DigiLocker — the session handling shared by every flow that
 * uses it: delivery partner KYC (services/rider-kyc.ts) and the one-time
 * identity verification of customers and shop owners
 * (services/identity-verification.ts, docs/identity-verification-2026-11).
 *
 *  - openDigilockerSession: a provider session whose return link is our
 *    shared /mobile-auth/digilocker-return?k=<random key> (the key finds the
 *    flow's row; the optional ".<scheme>" suffix says which app build to hand
 *    back to, decided here, never taken from the return request).
 *  - resolveDigilockerSession: where a session stands and, once the Aadhaar
 *    was shared, the name, the last four digits and DigiLocker's account id —
 *    never the number, photo, date of birth, address or the file itself.
 *
 * What a result means for the flow (Verified, name review, duplicates …) is
 * the flow's decision, not this module's.
 */
import { randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";
import { isMobileAppScheme, type MobileAppScheme } from "@/lib/mobile-app";

import { getDigilockerAdapter } from "./index";
import { KycConfigError, KycUnavailableError, type DigilockerAdapter, type DigilockerSession, type KycProviderId } from "./types";

/** Where DigiLocker sends the person back (a route: it needs no sign-in, the random key finds the row). */
export const DIGILOCKER_RETURN_PATH = "/mobile-auth/digilocker-return";
/** `<scheme>://digilocker-return` — how the return link hands back to the app's in-app browser. */
export const DIGILOCKER_APP_CALLBACK_HOST = "digilocker-return";
/**
 * How long the DigiLocker consent stays valid. Sandbox refuses under an hour, and
 * DigiLocker refuses a link opened with less than an hour of consent left — so
 * two hours leaves the link usable for about an hour.
 */
export const DIGILOCKER_CONSENT_MS = 2 * 60 * 60_000;
/** A link is handed out again only while DigiLocker will still open it (an hour of consent, plus a margin). */
export const DIGILOCKER_REUSE_MIN_LEFT_MS = 65 * 60_000;
/** Shown until DigiLocker shares the Aadhaar: no digits are known yet. */
export const DIGILOCKER_PENDING_MASK = "XXXX XXXX XXXX";

export type DigilockerSource = "kyc_provider" | "mock";

/** The site's public address (AUTH_URL). Behind a proxy a request's own origin is the internal one. */
export function siteBase(): string {
  return (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/+$/, "");
}

/** The app build a return key hands back to; null for a browser. */
export function digilockerReturnApp(returnKey: string | null | undefined): MobileAppScheme | null {
  const suffix = returnKey?.split(".")[1] ?? null;
  return isMobileAppScheme(suffix) ? suffix : null;
}

/** The shape every return key has (random base64url, optional ".<scheme>"). */
export function isDigilockerReturnKey(returnKey: string): boolean {
  return /^[A-Za-z0-9_-]{16,40}(\.[a-z-]{1,24})?$/.test(returnKey);
}

export function newDigilockerReturnKey(app: MobileAppScheme | null): string {
  return `${randomBytes(18).toString("base64url")}${app ? `.${app}` : ""}`;
}

export function digilockerReturnUrl(returnKey: string): string {
  const redirect = new URL(`${siteBase()}${DIGILOCKER_RETURN_PATH}`);
  redirect.searchParams.set("k", returnKey);
  return redirect.toString();
}

/** A provider problem as a short error code (vendor_* retryable, config_* needs an admin); anything else is rethrown. */
export function digilockerErrorCode(error: unknown, providerId: string, step: string, logPrefix: string): string {
  if (error instanceof KycUnavailableError) return `vendor_${error.code}`;
  if (error instanceof KycConfigError) {
    console.error(`[${logPrefix}] ${providerId} digilocker ${step}: ${error.code} — ${error.message}`);
    return `config_${error.code}`;
  }
  throw error;
}

export type OpenedDigilockerSession =
  | { kind: "open"; providerId: KycProviderId; session: DigilockerSession; returnKey: string; expiresAt: Date }
  /** The provider has no DigiLocker (Gridlines): an admin decides by hand. */
  | { kind: "unsupported"; providerId: string }
  | { kind: "error"; providerId: string; errorCode: string };

/** Starts a DigiLocker session. Never throws for a provider problem. */
export async function openDigilockerSession(
  source: DigilockerSource,
  idempotencyKey: string,
  app: MobileAppScheme | null,
  logPrefix: string,
): Promise<OpenedDigilockerSession> {
  const returnKey = newDigilockerReturnKey(app);
  const expiresAt = new Date(Date.now() + DIGILOCKER_CONSENT_MS);
  let providerId: string = source === "mock" ? "mock" : getEnv().KYC_PROVIDER;
  try {
    const picked = getDigilockerAdapter(source);
    providerId = picked.providerId;
    if (!picked.adapter) return { kind: "unsupported", providerId };
    const session = await picked.adapter.startSession(
      { redirectUrl: digilockerReturnUrl(returnKey), consentExpiryMs: expiresAt.getTime() },
      idempotencyKey,
    );
    return { kind: "open", providerId: picked.providerId, session, returnKey, expiresAt };
  } catch (error) {
    return { kind: "error", providerId, errorCode: digilockerErrorCode(error, providerId, "start", logPrefix) };
  }
}

export type DigilockerResolution =
  /** Still open: the person has not finished in DigiLocker yet. */
  | { kind: "waiting" }
  | {
      kind: "failed";
      errorCode: "digilocker_expired" | "digilocker_denied" | "digilocker_no_aadhaar";
      sessionStatus: "expired" | "failed" | "succeeded";
      providerRef?: string | null;
    }
  /** Shared: what we keep from the Aadhaar (any of it may be missing when the document can't be read). */
  | { kind: "shared"; name: string | null; last4: string | null; holderId: string | null; providerRef: string | null }
  | { kind: "unsupported" };

/**
 * Asks the provider where a session stands and, when the Aadhaar was shared,
 * reads it. Provider errors (KycUnavailableError / KycConfigError) are thrown
 * for the caller to turn into an error code (digilockerErrorCode).
 */
export async function resolveDigilockerSession(
  source: DigilockerSource,
  sessionId: string,
  sessionExpiresAt: Date | null,
  now: Date = new Date(),
): Promise<DigilockerResolution> {
  const { adapter } = getDigilockerAdapter(source);
  if (!adapter) return { kind: "unsupported" };
  return resolveWith(adapter, sessionId, sessionExpiresAt, now);
}

async function resolveWith(adapter: DigilockerAdapter, sessionId: string, sessionExpiresAt: Date | null, now: Date): Promise<DigilockerResolution> {
  const state = await adapter.sessionStatus(sessionId);
  if (!state) return { kind: "failed", errorCode: "digilocker_expired", sessionStatus: "expired" };
  if (state.status === "created") {
    const expired = (sessionExpiresAt?.getTime() ?? 0) <= now.getTime();
    return expired ? { kind: "failed", errorCode: "digilocker_expired", sessionStatus: "expired" } : { kind: "waiting" };
  }
  if (state.status === "failed") return { kind: "failed", errorCode: "digilocker_denied", sessionStatus: "failed" };
  if (state.status === "expired") return { kind: "failed", errorCode: "digilocker_expired", sessionStatus: "expired" };
  if (!state.documentsConsented.includes("aadhaar")) return { kind: "failed", errorCode: "digilocker_no_aadhaar", sessionStatus: "succeeded" };

  const outcome = await adapter.fetchAadhaar(sessionId);
  if (outcome.kind === "session_unusable") return { kind: "failed", errorCode: "digilocker_expired", sessionStatus: "expired" };
  if (outcome.kind === "not_shared") {
    return { kind: "failed", errorCode: "digilocker_no_aadhaar", sessionStatus: "succeeded", providerRef: outcome.providerRef };
  }
  return { kind: "shared", name: outcome.name, last4: outcome.last4, holderId: outcome.holderId, providerRef: outcome.providerRef };
}
