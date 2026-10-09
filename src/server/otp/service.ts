/**
 * Sign-in with a mobile number or an email address (GS-001). Codes are always
 * sent by email.
 *
 *  - Mobile number on file  → code goes to that account's email, shown masked.
 *  - Mobile number unknown  → the user is asked for an email; the code goes
 *                             there and, once verified, the number is saved on
 *                             the account (new or existing).
 *  - Email                  → code goes to that email; a new account is
 *                             created on first successful verification.
 *
 * Telling the caller whether a number is registered is a deliberate product
 * choice (decided with the owner): it is slowed by the per-IP and per-email
 * limits below. Only a salted HMAC of each code is stored; codes expire, the
 * attempt cap is enforced atomically, a new code supersedes the previous one,
 * and every request / success / failure is audited with masked identifiers.
 *
 * A mobile number added here is NOT verified (no SMS); `phoneVerifiedAt` stays
 * null and an admin can release a number someone claimed wrongly.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";

import { isValidEmail, maskEmailAddress, normalizeEmail, parseIndianMobile } from "@/lib/contact";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { bootstrapAdminEmails, getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, isUniqueViolation, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { loginOtps, users, wallets, type User, type UserRole } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { renderEmailChangeOtpEmail, renderOtpEmail } from "@/server/notifications/templates";
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";
import { NOTIFICATION_TYPES, notifyEvent } from "@/server/services/notifications";
import { grantRole } from "@/server/services/roles";
import { getRule } from "@/server/services/settings";
import { smsProvider } from "./providers";

export const OTP_INVALID = "That code is wrong or has expired. Check the latest email or request a new code.";
export const MOBILE_IN_USE =
  "This mobile number is already linked to another account. Sign in with that account, or contact support if the number is yours.";
export const EMAIL_IN_USE = "This email address is already used by another account.";

type OtpPurpose = "LOGIN" | "EMAIL_CHANGE";

export type LoginOtpRequestResult =
  /** Sent to the email in the request. */
  | { status: "SENT"; maskedEmail: string; resendAfterSeconds: number; expiryMinutes: number }
  /**
   * A mobile number on its own gets this same reply whether or not it is
   * registered, so the form cannot be used to find out. A registered number's
   * code goes to its account's email; a new number signs up by requesting
   * again with an email.
   */
  | { status: "SENT_IF_REGISTERED"; resendAfterSeconds: number; expiryMinutes: number };

export interface VerifiedLogin {
  user: User;
  isNewUser: boolean;
}

/* --------------------------------------------------------------- helpers */

function hashCode(salt: string, email: string, code: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`${salt}:${email}:${code}`).digest("hex");
  return `${salt}:${mac}`;
}

function matches(stored: string, email: string, code: string): boolean {
  const [salt] = stored.split(":");
  if (!salt) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(hashCode(salt, email, code));
  return a.length === b.length && timingSafeEqual(a, b);
}

function generateCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

function parseEmail(input: string): string {
  if (!isValidEmail(input)) throw validationFailed("Enter a valid email address, e.g. name@example.com.");
  return normalizeEmail(input);
}

function parseMobile(input: string): { e164: string; national: string } {
  const parsed = parseIndianMobile(input);
  if (!parsed.ok) throw validationFailed(parsed.error);
  return parsed;
}

async function findLiveUserByEmail(email: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
  return row;
}

async function findLiveUserByPhone(e164: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(and(eq(users.phoneE164, e164), isNull(users.deletedAt)));
  return row;
}

function auditOtp(
  action: AuditAction,
  details: { email: string; phoneE164?: string | null; actorId?: string | null; ip?: string | null } & Record<string, unknown>,
) {
  const { email, phoneE164, actorId, ip, ...extra } = details;
  return recordAudit({
    actorId: actorId ?? null,
    action,
    entityType: "login_otp",
    newValue: {
      email: maskEmailAddress(email),
      ...(phoneE164 ? { phone: maskPhone(phoneE164) } : {}),
      ...extra,
    },
    ipAddress: ip ?? null,
  });
}

/**
 * Issues and emails a code. Throttled per destination email: a cooldown
 * between codes and a cap per window. Callers add a per-IP limit.
 */
async function issueCode(input: {
  email: string;
  purpose: OtpPurpose;
  userId: string | null;
  phoneE164: string | null;
  ip: string | null;
  /** Module 3: send by SMS to `phoneE164` (an account with no real email). */
  bySms?: boolean;
}): Promise<{ resendAfterSeconds: number; expiryMinutes: number }> {
  const rules = await getRule("otp");
  const now = Date.now();
  const windowStart = new Date(now - rules.resendWindowMinutes * 60_000);

  const recent = await db
    .select({ createdAt: loginOtps.createdAt })
    .from(loginOtps)
    .where(and(eq(loginOtps.email, input.email), eq(loginOtps.purpose, input.purpose), gt(loginOtps.createdAt, windowStart)))
    .orderBy(desc(loginOtps.createdAt));

  const last = recent[0]?.createdAt.getTime();
  if (last !== undefined && now - last < rules.resendCooldownSeconds * 1000) {
    const wait = Math.ceil((rules.resendCooldownSeconds * 1000 - (now - last)) / 1000);
    await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { ...input, reason: "cooldown" });
    throw new AppError("RATE_LIMITED", `Please wait ${wait} seconds before requesting another code.`, {
      retryAfterSeconds: wait,
    });
  }
  if (recent.length >= rules.maxResendsPerWindow) {
    await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { ...input, reason: "window_limit" });
    throw new AppError("RATE_LIMITED", "Too many codes were requested for this email. Try again later.", {
      retryAfterSeconds: rules.resendWindowMinutes * 60,
    });
  }

  const code = generateCode(rules.length);
  const salt = randomBytes(8).toString("hex");
  const id = await db.transaction(async (tx) => {
    await tx
      .update(loginOtps)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(loginOtps.email, input.email),
          eq(loginOtps.purpose, input.purpose),
          isNull(loginOtps.consumedAt),
          isNull(loginOtps.supersededAt),
        ),
      );
    const [row] = await tx
      .insert(loginOtps)
      .values({
        userId: input.userId,
        email: input.email,
        phoneE164: input.phoneE164,
        purpose: input.purpose,
        channel: input.bySms ? "SMS" : "EMAIL",
        codeHash: hashCode(salt, input.email, code),
        expiresAt: new Date(now + rules.expiryMinutes * 60_000),
        maxAttempts: rules.maxAttempts,
        ipAddress: input.ip,
      })
      .returning({ id: loginOtps.id });
    return row.id;
  });

  const message =
    input.purpose === "LOGIN"
      ? renderOtpEmail(code, rules.expiryMinutes)
      : renderEmailChangeOtpEmail(code, rules.expiryMinutes);
  try {
    const sms = input.bySms ? smsProvider() : null;
    if (input.bySms && (!sms || !input.phoneE164)) throw new Error("SMS is not available for this sign-in code.");
    if (sms && input.phoneE164) await sms.send({ to: input.phoneE164, code, expiryMinutes: rules.expiryMinutes });
    else await sendEmail({ to: input.email, ...message });
  } catch (error) {
    console.error("[otp] delivery failed", error);
    await db.update(loginOtps).set({ supersededAt: new Date() }).where(eq(loginOtps.id, id));
    await auditOtp(AUDIT_ACTIONS.OTP_FAILED, { ...input, reason: "delivery_failed", otpId: id });
    throw new AppError("INTERNAL", "We could not send the email just now. Please try again in a minute.");
  }

  await auditOtp(AUDIT_ACTIONS.OTP_REQUESTED, { ...input, purpose: input.purpose, otpId: id, known: Boolean(input.userId) });
  return { resendAfterSeconds: rules.resendCooldownSeconds, expiryMinutes: rules.expiryMinutes };
}

/**
 * Checks a code for `email` + `purpose` and consumes it. Every failure throws
 * the same message; the reason is audited.
 */
async function consumeCode(input: {
  email: string;
  purpose: OtpPurpose;
  code: string;
  ip: string | null;
  /** When set, the code must have been issued for this mobile number. */
  phoneE164?: string | null;
  /** When set, the code must have been issued to this user (email change). */
  userId?: string | null;
}): Promise<typeof loginOtps.$inferSelect> {
  const fail = async (reason: string, extra: Record<string, unknown> = {}): Promise<never> => {
    await auditOtp(AUDIT_ACTIONS.OTP_FAILED, { email: input.email, phoneE164: input.phoneE164, ip: input.ip, reason, ...extra });
    throw validationFailed(OTP_INVALID);
  };

  const code = input.code.replace(/\s/g, "");
  if (!/^\d{4,8}$/.test(code)) return fail("malformed");

  const [otp] = await db
    .select()
    .from(loginOtps)
    .where(
      and(
        eq(loginOtps.email, input.email),
        eq(loginOtps.purpose, input.purpose),
        isNull(loginOtps.consumedAt),
        isNull(loginOtps.supersededAt),
      ),
    )
    .orderBy(desc(loginOtps.createdAt))
    .limit(1);

  if (!otp) return fail("none");
  if (otp.expiresAt.getTime() <= Date.now()) return fail("expired", { otpId: otp.id });
  if (input.phoneE164 !== undefined && (otp.phoneE164 ?? null) !== (input.phoneE164 ?? null)) {
    return fail("identifier_mismatch", { otpId: otp.id });
  }
  if (input.userId !== undefined && otp.userId !== input.userId) return fail("user_mismatch", { otpId: otp.id });

  // Count the attempt first, atomically; the cap therefore holds under concurrency.
  const [counted] = await db
    .update(loginOtps)
    .set({ attempts: sql`${loginOtps.attempts} + 1` })
    .where(and(eq(loginOtps.id, otp.id), isNull(loginOtps.consumedAt), sql`${loginOtps.attempts} < ${loginOtps.maxAttempts}`))
    .returning({ attempts: loginOtps.attempts });
  if (!counted) {
    await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { email: input.email, ip: input.ip, reason: "max_attempts", otpId: otp.id });
    throw validationFailed("Too many wrong attempts. Request a new code.");
  }

  if (!matches(otp.codeHash, input.email, code)) {
    return fail("mismatch", { attempts: counted.attempts, otpId: otp.id });
  }

  // Single use: only one concurrent verifier can flip consumed_at.
  const [used] = await db
    .update(loginOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(loginOtps.id, otp.id), isNull(loginOtps.consumedAt)))
    .returning({ id: loginOtps.id });
  if (!used) return fail("already_used", { otpId: otp.id });
  return otp;
}

/* ----------------------------------------------------------------- login */

export async function requestLoginOtp(input: {
  mobile?: string | null;
  email?: string | null;
  ip?: string | null;
  /**
   * Runs a mobile-only request's lookup follow-up (sending the code). The
   * route passes `after`, so a registered number answers as fast as an
   * unregistered one; without it the work runs before returning.
   */
  defer?: (task: () => Promise<void>) => void;
}): Promise<LoginOtpRequestResult> {
  const ip = input.ip ?? null;
  const email = input.email?.trim() ? parseEmail(input.email) : null;

  if (input.mobile?.trim() && !email) {
    const mobile = parseMobile(input.mobile);
    const rules = await getRule("otp");
    // Limited per number whether or not it is registered, so hitting the
    // limit tells nothing either.
    enforceRateLimit(`otp-mobile:${mobile.e164}`, {
      limit: rules.maxResendsPerWindow,
      windowMs: rules.resendWindowMinutes * 60_000,
    });
    const owner = await findLiveUserByPhone(mobile.e164);
    const followUp = async () => {
      if (!owner) return;
      if (owner.status !== "ACTIVE") {
        await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { email: owner.email, phoneE164: mobile.e164, ip, reason: "account_blocked" });
        return;
      }
      // Module 3: an owner registered from a mobile number alone gets the code by SMS.
      const bySms = owner.emailPlaceholder || isPlaceholderEmail(owner.email);
      await issueCode({ email: owner.email, purpose: "LOGIN", userId: owner.id, phoneE164: mobile.e164, ip, bySms }).catch(
        (error: unknown) => {
          // Cooldowns and failed sends are audited by issueCode; the reply stays the same.
          if (!(error instanceof AppError)) console.error("[otp] mobile sign-in code failed", error);
        },
      );
    };
    if (input.defer) input.defer(followUp);
    else await followUp();
    return { status: "SENT_IF_REGISTERED", resendAfterSeconds: rules.resendCooldownSeconds, expiryMinutes: rules.expiryMinutes };
  }

  if (!email) throw validationFailed("Enter your mobile number or email address.");
  // The code goes to the email given, never to the account a number belongs
  // to: answering with that account's address, or refusing an email that is
  // registered with another number, would tell anyone which numbers have
  // accounts. Verifying links the number only if it is free.
  const phoneE164 = input.mobile?.trim() ? parseMobile(input.mobile).e164 : null;
  const owner = await findLiveUserByEmail(email);
  if (owner && owner.status !== "ACTIVE") {
    const rules = await getRule("otp");
    await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { email, phoneE164, ip, reason: "account_blocked" });
    return {
      status: "SENT",
      maskedEmail: maskEmailAddress(email),
      resendAfterSeconds: rules.resendCooldownSeconds,
      expiryMinutes: rules.expiryMinutes,
    };
  }
  const sent = await issueCode({ email, purpose: "LOGIN", userId: owner?.id ?? null, phoneE164, ip });
  return { status: "SENT", maskedEmail: maskEmailAddress(email), ...sent };
}

const ACCOUNT_BLOCKED =
  "This account is suspended or closed, so it cannot sign in. If you think this is a mistake, contact us through the grievance form.";

/**
 * Verifies a login code. On success returns the account, creating it (with a
 * wallet) on first sign-in and saving the mobile number the code was
 * requested with if the account has none yet.
 */
export async function verifyLoginOtp(input: {
  mobile?: string | null;
  email?: string | null;
  code: string;
  ip?: string | null;
}): Promise<VerifiedLogin> {
  const ip = input.ip ?? null;
  const mobile = input.mobile?.trim() ? parseIndianMobile(input.mobile) : null;
  if (mobile && !mobile.ok) throw validationFailed(OTP_INVALID);
  const phoneE164 = mobile?.ok ? mobile.e164 : null;

  let email: string;
  if (input.email?.trim()) {
    if (!isValidEmail(input.email)) throw validationFailed(OTP_INVALID);
    email = normalizeEmail(input.email);
  } else if (phoneE164) {
    const owner = await findLiveUserByPhone(phoneE164);
    if (!owner) throw validationFailed(OTP_INVALID);
    email = owner.email;
  } else {
    throw validationFailed(OTP_INVALID);
  }

  const otp = await consumeCode({ email, purpose: "LOGIN", code: input.code, ip, phoneE164 });

  const existing = await findLiveUserByEmail(email);
  let user: User;
  let isNewUser = false;
  if (existing) {
    if (existing.status !== "ACTIVE") throw forbidden(ACCOUNT_BLOCKED);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (!existing.emailVerified) patch.emailVerified = new Date();
    if (otp.phoneE164 && !existing.phoneE164) {
      await assertPhoneFree(otp.phoneE164, existing.id);
      patch.phoneE164 = otp.phoneE164;
      patch.phone = otp.phoneE164.slice(3);
    }
    user = existing;
    if (Object.keys(patch).length > 0) {
      try {
        [user] = await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, existing.id)).returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(MOBILE_IN_USE);
        throw error;
      }
    }
  } else {
    if (otp.phoneE164) await assertPhoneFree(otp.phoneE164, null);
    user = await createCustomerAccount({ email, phoneE164: otp.phoneE164, ip });
    isNewUser = true;
  }

  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email, phoneE164, actorId: user.id, ip, otpId: otp.id, newUser: isNewUser });
  if (!isNewUser) {
    await notifyEvent(NOTIFICATION_TYPES.SECURITY_SIGN_IN, user.id, {
      at: new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: getEnv().APP_TIMEZONE }),
    });
  }
  return { user, isNewUser };
}

async function assertPhoneFree(e164: string, exceptUserId: string | null): Promise<void> {
  const conditions = [eq(users.phoneE164, e164), isNull(users.deletedAt)];
  if (exceptUserId) conditions.push(ne(users.id, exceptUserId));
  const [taken] = await db.select({ id: users.id }).from(users).where(and(...conditions));
  if (taken) throw conflict(MOBILE_IN_USE);
}

/** First sign-in: CUSTOMER (or bootstrap ADMIN) with a wallet and the sign-up consent recorded. */
async function createCustomerAccount(input: { email: string; phoneE164: string | null; ip: string | null }): Promise<User> {
  const role: UserRole = bootstrapAdminEmails().includes(input.email) ? "ADMIN" : "CUSTOMER";
  let created: User;
  try {
    created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email: input.email,
          emailVerified: new Date(),
          phoneE164: input.phoneE164,
          phone: input.phoneE164 ? input.phoneE164.slice(3) : null,
          role,
        })
        .returning();
      await tx.insert(wallets).values({ userId: row.id }).onConflictDoNothing();
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(input.phoneE164 ? MOBILE_IN_USE : EMAIL_IN_USE);
    }
    throw error;
  }
  if (role === "ADMIN") await grantRole(created.id, "ADMIN", { source: "BOOTSTRAP" });
  // The sign-in form requires ticking the Terms & Privacy box before a code can be requested.
  await recordConsent(created.id, "TERMS_AND_PRIVACY", { ipAddress: input.ip }).catch((error) => {
    console.error("[otp] failed to record sign-up consent", error);
  });
  return created;
}

/* ----------------------------------------------------------- login ticket */

const TICKET_TTL_MS = 60_000;

function ticketMac(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`login-ticket:${payload}`).digest("hex");
}

/**
 * After a code is verified on the server, Auth.js is handed this short-lived
 * signed ticket to open the session. It never reaches the browser.
 */
export function createLoginTicket(userId: string): string {
  const payload = `${userId}.${Date.now() + TICKET_TTL_MS}`;
  return `${payload}.${ticketMac(payload)}`;
}

export function readLoginTicket(ticket: string): string | null {
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const payload = `${userId}.${expires}`;
  const expected = Buffer.from(ticketMac(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!(Number(expires) > Date.now())) return null;
  return userId;
}

/* ---------------------------------------------------------- email change */

export async function requestEmailChangeOtp(
  userId: string,
  input: { email: string; ip?: string | null },
): Promise<{ maskedEmail: string; resendAfterSeconds: number; expiryMinutes: number }> {
  const email = parseEmail(input.email);
  const [current] = await db.select().from(users).where(eq(users.id, userId));
  if (!current) throw forbidden();
  if (current.email === email) throw validationFailed("That is already your email address.");
  const taken = await findLiveUserByEmail(email);
  if (taken) throw conflict(EMAIL_IN_USE);
  const sent = await issueCode({ email, purpose: "EMAIL_CHANGE", userId, phoneE164: null, ip: input.ip ?? null });
  return { maskedEmail: maskEmailAddress(email), ...sent };
}

export async function confirmEmailChange(
  userId: string,
  role: UserRole,
  input: { email: string; code: string; ip?: string | null },
): Promise<{ email: string }> {
  const email = parseEmail(input.email);
  await consumeCode({ email, purpose: "EMAIL_CHANGE", code: input.code, ip: input.ip ?? null, userId });

  const [before] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!before) throw forbidden();
  if ((await findLiveUserByEmail(email))?.id) throw conflict(EMAIL_IN_USE);
  try {
    await db.update(users).set({ email, emailVerified: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(EMAIL_IN_USE);
    throw error;
  }

  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.EMAIL_CHANGED,
    entityType: "user",
    entityId: userId,
    previousValue: { email: maskEmailAddress(before.email) },
    newValue: { email: maskEmailAddress(email) },
    ipAddress: input.ip ?? null,
  });
  // Tell the old inbox too: if this was not the owner, that is where they will notice.
  void sendEmail({
    to: before.email,
    subject: "Your Gokesari email address was changed",
    text: `The sign-in email on your Gokesari account was changed to ${maskEmailAddress(email)}. If this was not you, contact support immediately.\n`,
    html: `<p>The sign-in email on your Gokesari account was changed to <strong>${maskEmailAddress(email)}</strong>.</p><p>If this was not you, contact support immediately.</p>`,
  }).catch((error) => console.error("[otp] old-email notice failed", error));
  return { email };
}

/* ---------------------------------------------------------- mobile number */

/** Links (or replaces) the account's mobile number. Not verified: codes only go by email. */
export async function linkPhone(
  userId: string,
  role: User["role"],
  input: { mobile: string },
): Promise<{ phoneE164: string }> {
  const parsed = parseIndianMobile(input.mobile);
  if (!parsed.ok) throw validationFailed(parsed.error);
  const [current] = await db.select({ phoneE164: users.phoneE164 }).from(users).where(eq(users.id, userId));
  if (current?.phoneE164 === parsed.e164) return { phoneE164: parsed.e164 };
  await assertPhoneFree(parsed.e164, userId);
  try {
    await db
      .update(users)
      .set({ phoneE164: parsed.e164, phone: parsed.national, phoneVerifiedAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(MOBILE_IN_USE);
    throw error;
  }
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.PHONE_LINKED,
    entityType: "user",
    entityId: userId,
    newValue: { phone: maskPhone(parsed.e164) },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED, userId, { action: current?.phoneE164 ? "changed" : "added" });
  return { phoneE164: parsed.e164 };
}

export async function unlinkPhone(userId: string, role: User["role"]): Promise<void> {
  await db
    .update(users)
    .set({ phoneE164: null, phoneVerifiedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.PHONE_LINKED,
    entityType: "user",
    entityId: userId,
    newValue: { phone: null },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED, userId, { action: "removed" });
}
