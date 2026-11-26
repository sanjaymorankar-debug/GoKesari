/**
 * docs/sms-2fa-2026-11 (3a): a second sign-in factor by SMS.
 *
 * With the switch for the account's audience on — sms_otp_signin_customers_enabled
 * (CUSTOMER) or sms_otp_signin_shop_owners_enabled (SHOP_OWNER), set at Admin →
 * Sign-in security; other roles are never asked — AND SMS codes available
 * (SMS_PROVIDER mock / msg91 with keys, rule otp.smsEnabled):
 *
 *   emailed code verified → NOT signed in yet: the browser gets a signed,
 *   15-minute challenge (bound to the user) and a code is sent by SMS to the
 *   account's verified mobile → SMS code verified → login ticket → session.
 *
 * An account without a verified mobile gives its number in the same step; the
 * code goes there and, once verified, the number is saved with phoneVerifiedAt.
 * Codes are login_otps rows (purpose LOGIN_SMS): the same hashing, expiry,
 * cooldown, per-account / per-IP limits, attempt lockout and audit as the
 * emailed code.
 *
 * Switch off (takes effect at once; verified numbers stay verified), another role, or SMS not available → `secondFactorRequired`
 * is false and sign-in is exactly as before (email only): production without
 * an SMS vendor can never lock anyone out.
 *
 * Accounts registered with a mobile number alone (placeholder email) already
 * get their sign-in code by SMS, so they are not asked twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { maskEmailAddress, parseIndianMobile } from "@/lib/contact";
import { getEnv } from "@/lib/env";
import { conflict, forbidden, isUniqueViolation, validationFailed, AppError } from "@/lib/errors";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { users, type FeatureFlagKey, type User, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { NOTIFICATION_TYPES, notifyEvent } from "@/server/services/notifications";
import { getOtpProvider } from "./providers";
import { MOBILE_IN_USE, assertPhoneFree, auditOtp, consumeCode, createLoginTicket, issueCode, type OtpPurpose } from "./service";

/**
 * The one switch per audience (Admin → Sign-in security). Only these roles can
 * ever be asked; every other role (admin, rider, dealer, staff …) signs in as before.
 */
export const SMS_SIGNIN_FLAG_BY_ROLE = {
  CUSTOMER: "sms_otp_signin_customers_enabled",
  SHOP_OWNER: "sms_otp_signin_shop_owners_enabled",
} as const satisfies Partial<Record<UserRole, FeatureFlagKey>>;
export const SECOND_FACTOR_ROLES: readonly UserRole[] = Object.keys(SMS_SIGNIN_FLAG_BY_ROLE) as UserRole[];

function signInFlagFor(role: UserRole): FeatureFlagKey | null {
  return (SMS_SIGNIN_FLAG_BY_ROLE as Partial<Record<UserRole, FeatureFlagKey>>)[role] ?? null;
}
export const SECOND_FACTOR_TTL_MS = 15 * 60_000;

export const SECOND_FACTOR_EXPIRED = "This sign-in has expired. Please start again with your email code.";

/** Can one-time codes go by SMS on this server right now (environment + rule otp.smsEnabled)? */
export async function smsCodesAvailable(): Promise<boolean> {
  return (await getOtpProvider("SMS")) !== null;
}

/** Must this account confirm its sign-in with an SMS code? */
export async function secondFactorRequired(user: Pick<User, "role" | "email" | "emailPlaceholder">): Promise<boolean> {
  const flag = signInFlagFor(user.role);
  if (!flag) return false;
  if (user.emailPlaceholder || isPlaceholderEmail(user.email)) return false;
  if (!(await getFeatureFlag(flag)).enabled) return false;
  return smsCodesAvailable();
}

/* ------------------------------------------------------------- challenge */

/**
 * The factor still to give: SMS (the first was the e-mail, Google or the link) or, docs/dual-auth-2026-11, EMAIL
 * (the first was an SMS code to the mobile).
 */
export type SecondFactorKind = "SMS" | "EMAIL";

function challengeMac(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`sms-2fa-challenge:${payload}`).digest("base64url");
}

/**
 * Proof that the first factor was verified for this user; never a session by itself.
 * SMS step: `<user>.<expires>.<mac>` (unchanged); e-mail step: `<user>.<expires>.E.<mac>`.
 */
export function createSecondFactorChallenge(userId: string, now = Date.now(), kind: SecondFactorKind = "SMS"): string {
  const payload = `${userId}.${now + SECOND_FACTOR_TTL_MS}${kind === "EMAIL" ? ".E" : ""}`;
  return `${payload}.${challengeMac(payload)}`;
}

export function readSecondFactorChallengeKind(challenge: string, now = Date.now()): { userId: string; kind: SecondFactorKind } | null {
  const parts = String(challenge ?? "").split(".");
  if (parts.length !== 3 && !(parts.length === 4 && parts[2] === "E")) return null;
  const kind: SecondFactorKind = parts.length === 4 ? "EMAIL" : "SMS";
  const [userId, expires] = parts;
  const mac = parts[parts.length - 1];
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d+$/.test(expires)) return null;
  const expected = Buffer.from(challengeMac(parts.slice(0, -1).join(".")));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!(Number(expires) > now)) return null;
  return { userId, kind };
}

export function readSecondFactorChallenge(challenge: string, now = Date.now()): string | null {
  return readSecondFactorChallengeKind(challenge, now)?.userId ?? null;
}

async function challengeUserKind(challenge: string): Promise<{ user: User; kind: SecondFactorKind }> {
  const read = readSecondFactorChallengeKind(challenge);
  if (!read) throw validationFailed(SECOND_FACTOR_EXPIRED);
  const [user] = await db.select().from(users).where(and(eq(users.id, read.userId), isNull(users.deletedAt)));
  if (!user || user.status !== "ACTIVE") throw forbidden("This account cannot sign in.");
  return { user, kind: read.kind };
}


/**
 * docs/dual-auth-2026-11: which second factor this sign-in still needs before the session opens (null = none).
 *
 * dual_auth in force:
 *   - the factor the account has NOT verified yet is not asked here: the session opens with one factor and the
 *     DualVerify gate (policy.ts) asks for it before any order, shop / dealer / admin work or withdrawal;
 *   - otherwise the other factor, unless this browser is trusted for the account and the role may use device
 *     trust (staff: always both).
 * dual_auth off: the SMS switches of docs/sms-2fa-2026-11 as before.
 */
export async function secondFactorKind(user: User, firstFactor: SecondFactorKind = "EMAIL"): Promise<SecondFactorKind | null> {
  const { dualAuthInForce, emailFactorVerified, isStaffRole } = await import("@/server/dual-auth/policy");
  if (await dualAuthInForce()) {
    const other: SecondFactorKind = firstFactor === "EMAIL" ? "SMS" : "EMAIL";
    if (other === "SMS" && !hasVerifiedPhone(user)) return null;
    if (other === "EMAIL" && !(await emailFactorVerified(user))) return null;
    if (!isStaffRole(user.role)) {
      const { isDeviceTrusted } = await import("@/server/dual-auth/devices");
      if (await isDeviceTrusted(user.id)) return null;
    }
    return other;
  }
  if (firstFactor !== "EMAIL") return null;
  return (await secondFactorRequired(user)) ? "SMS" : null;
}

/* ------------------------------------------------------- shared SMS target */

export function hasVerifiedPhone(user: Pick<User, "phoneE164" | "phoneVerifiedAt">): user is { phoneE164: string; phoneVerifiedAt: Date } {
  return Boolean(user.phoneE164 && user.phoneVerifiedAt);
}

/**
 * Where an SMS code for this user goes: the verified mobile on the account, or
 * (none yet) the number they give now, which must not belong to another account.
 */
export async function resolveSmsTarget(user: User, mobile: string | null | undefined): Promise<string> {
  if (hasVerifiedPhone(user)) return user.phoneE164;
  if (!mobile?.trim()) throw validationFailed("Enter your 10-digit mobile number.", { needsPhone: true });
  const parsed = parseIndianMobile(mobile);
  if (!parsed.ok) throw validationFailed(parsed.error, { needsPhone: true });
  await assertPhoneFree(parsed.e164, user.id);
  return parsed.e164;
}

/** Saves a number just proven by an SMS code as the account's verified mobile. */
export async function markPhoneVerified(user: User, e164: string): Promise<User> {
  if (user.phoneE164 === e164 && user.phoneVerifiedAt) return user;
  let updated: User;
  try {
    [updated] = await db
      .update(users)
      .set({ phoneE164: e164, phone: e164.slice(3), phoneVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(MOBILE_IN_USE);
    throw error;
  }
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.PHONE_LINKED,
    entityType: "user",
    entityId: user.id,
    newValue: { phone: maskPhone(e164), verified: true },
  });
  if (user.phoneE164 !== e164) {
    await notifyEvent(NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED, user.id, { action: user.phoneE164 ? "changed" : "added" }).catch((error) =>
      console.error("[sms-2fa] phone notice failed", error),
    );
  }
  return updated;
}

/** Sends an SMS code for `purpose` to `target` (rate limits, expiry and audit as for every code). */
export async function sendSmsCode(user: User, target: string, purpose: Extract<OtpPurpose, "LOGIN_SMS" | "CHECKOUT" | "LEGAL_ESIGN">, ip: string | null) {
  const sent = await issueCode({ email: user.email, purpose, userId: user.id, phoneE164: target, ip, bySms: true });
  return { maskedPhone: maskPhone(target), ...sent };
}

/** Checks and consumes an SMS code for `purpose`; the code must have gone to `target` for this user. */
export async function consumeSmsCode(user: User, target: string, purpose: Extract<OtpPurpose, "LOGIN_SMS" | "CHECKOUT" | "LEGAL_ESIGN">, code: string, ip: string | null) {
  const otp = await consumeCode({ email: user.email, purpose, code, ip, phoneE164: target, userId: user.id });
  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: user.email, phoneE164: target, actorId: user.id, ip, otpId: otp.id, purpose });
  return otp;
}

/* ------------------------------------------------------------- sign-in */

export interface SecondFactorPrompt {
  challenge: string;
  /** docs/dual-auth-2026-11: SMS (default) or EMAIL — a code to the account's e-mail after an SMS first factor. */
  kind?: SecondFactorKind;
  /** EMAIL step: where the code went, masked. */
  maskedEmail?: string | null;
  /** The account has no verified mobile: ask for the number first. */
  needsPhone: boolean;
  /** Where the code went (verified mobile), masked. */
  maskedPhone: string | null;
  resendAfterSeconds: number | null;
  expiryMinutes: number | null;
  /** The code could not be sent straight away (e.g. a cooldown); the person can press Resend. */
  sendError: string | null;
}

/**
 * Called once the emailed code is verified. Returns the login ticket when the
 * account needs no SMS factor, else the prompt for the SMS step (the code is
 * already on its way when the account has a verified mobile).
 */
export async function afterEmailFactor(
  user: User,
  ip: string | null,
  firstFactor: SecondFactorKind = "EMAIL",
): Promise<{ ticket: string; secondFactor?: undefined } | { ticket?: undefined; secondFactor: SecondFactorPrompt }> {
  const kind = await secondFactorKind(user, firstFactor);
  if (!kind) {
    await auditDualSignIn(user, ip, { factors: [firstFactor], secondFactor: "not_asked" });
    return { ticket: createLoginTicket(user.id) };
  }
  return { secondFactor: await beginSecondFactor(user, ip, undefined, kind) };
}

/** docs/dual-auth-2026-11: every sign-in while the rule is in force, with the factors given (audit, IST in the admin log). */
export async function auditDualSignIn(user: User, ip: string | null, detail: Record<string, unknown>): Promise<void> {
  const { dualAuthInForce } = await import("@/server/dual-auth/policy");
  if (!(await dualAuthInForce())) return;
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.DUAL_AUTH_SIGN_IN, entityType: "user", entityId: user.id, newValue: detail, ipAddress: ip });
}

/** The second step for a challenge made earlier (the Google path keeps it in a cookie). */
export async function resumeSecondFactor(challenge: string, ip: string | null): Promise<SecondFactorPrompt> {
  const { user, kind } = await challengeUserKind(challenge);
  return beginSecondFactor(user, ip, challenge, kind);
}

export async function beginSecondFactor(user: User, ip: string | null, existingChallenge?: string, kind: SecondFactorKind = "SMS"): Promise<SecondFactorPrompt> {
  const challenge = existingChallenge ?? createSecondFactorChallenge(user.id, Date.now(), kind);
  if (kind === "EMAIL") {
    const maskedEmail = maskEmailAddress(user.email);
    try {
      const sent = await issueCode({ email: user.email, purpose: "LOGIN_EMAIL", userId: user.id, phoneE164: null, ip });
      return { challenge, kind, maskedEmail, needsPhone: false, maskedPhone: null, resendAfterSeconds: sent.resendAfterSeconds, expiryMinutes: sent.expiryMinutes, sendError: null };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { challenge, kind, maskedEmail, needsPhone: false, maskedPhone: null, resendAfterSeconds: null, expiryMinutes: null, sendError: error.message };
    }
  }
  if (!hasVerifiedPhone(user)) {
    return { challenge, needsPhone: true, maskedPhone: null, resendAfterSeconds: null, expiryMinutes: null, sendError: null };
  }
  try {
    const sent = await sendSmsCode(user, user.phoneE164, "LOGIN_SMS", ip);
    return { challenge, needsPhone: false, maskedPhone: sent.maskedPhone, resendAfterSeconds: sent.resendAfterSeconds, expiryMinutes: sent.expiryMinutes, sendError: null };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { challenge, needsPhone: false, maskedPhone: maskPhone(user.phoneE164), resendAfterSeconds: null, expiryMinutes: null, sendError: error.message };
  }
}

/** Sends (or re-sends) the sign-in SMS code. `mobile` is used only when the account has no verified mobile. */
export async function sendSecondFactorCode(input: { challenge: string; mobile?: string | null; ip?: string | null }) {
  const { user, kind } = await challengeUserKind(input.challenge);
  if (kind === "EMAIL") {
    const sent = await issueCode({ email: user.email, purpose: "LOGIN_EMAIL", userId: user.id, phoneE164: null, ip: input.ip ?? null });
    return { maskedPhone: maskEmailAddress(user.email), ...sent };
  }
  const target = await resolveSmsTarget(user, input.mobile);
  return sendSmsCode(user, target, "LOGIN_SMS", input.ip ?? null);
}

/**
 * Verifies the sign-in SMS code. On success the number is the account's
 * verified mobile, and the caller opens the session with a login ticket.
 */
export async function verifySecondFactorCode(input: { challenge: string; code: string; mobile?: string | null; ip?: string | null }): Promise<User> {
  const { user, kind } = await challengeUserKind(input.challenge);
  if (kind === "EMAIL") {
    const otp = await consumeCode({ email: user.email, purpose: "LOGIN_EMAIL", code: input.code, ip: input.ip ?? null, userId: user.id });
    await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: user.email, actorId: user.id, ip: input.ip ?? null, otpId: otp.id, purpose: "LOGIN_EMAIL" });
    await auditDualSignIn(user, input.ip ?? null, { factors: ["SMS", "EMAIL"] });
    return user;
  }
  const target = await resolveSmsTarget(user, input.mobile);
  await consumeSmsCode(user, target, "LOGIN_SMS", input.code, input.ip ?? null);
  const updated = await markPhoneVerified(user, target);
  await auditDualSignIn(updated, input.ip ?? null, { factors: ["EMAIL", "SMS"] });
  return updated;
}
