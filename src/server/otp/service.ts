/**
 * Mobile-login one-time codes (GS-001).
 *
 * Flow: mobile number → choose where to receive the code → code emailed to the
 * verified address on the account → code entered → session issued by Auth.js.
 *
 * Properties, all driven by the `otp` rule group (config/rules.ts):
 *  - only a salted HMAC of the code is stored; codes expire; attempts are capped
 *  - a new code invalidates the previous one; resend has a cooldown and a
 *    per-window cap, counted per number whether or not an account exists
 *  - requests for unknown numbers look exactly like requests for known ones
 *    (same status, same message, same throttling) — no account enumeration
 *  - every request / success / failure / block is audited (numbers masked)
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { AppError, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { maskPhone, parsePhone } from "@/lib/phone";
import { db } from "@/server/db";
import { loginOtps, users, type User } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from "@/server/services/audit";
import { NOTIFICATION_TYPES, notifyEvent } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { getProvider, type OtpChannel } from "./providers";

/** Same words for every outcome the caller must not be able to tell apart. */
export const OTP_REQUEST_ACK =
  "If that mobile number is registered, a code has been sent to the email address on the account.";
export const OTP_INVALID = "That code is invalid or has expired. Request a new one.";

export interface OtpRequestResult {
  message: string;
  channel: OtpChannel;
  /** Seconds until another code may be requested — identical for known and unknown numbers. */
  resendAfterSeconds: number;
}

function hashCode(salt: string, phone: string, code: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`${salt}:${phone}:${code}`).digest("hex");
  return `${salt}:${mac}`;
}

function matches(stored: string, phone: string, code: string): boolean {
  const [salt] = stored.split(":");
  if (!salt) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(hashCode(salt, phone, code));
  return a.length === b.length && timingSafeEqual(a, b);
}

function generateCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export async function requestLoginOtp(input: {
  countryCode: string;
  mobile: string;
  channel: OtpChannel;
  ip?: string | null;
}): Promise<OtpRequestResult>;
export async function requestLoginOtp(input: {
  email: string;
  channel: OtpChannel;
  ip?: string | null;
}): Promise<OtpRequestResult & { maskedEmail?: string }>;
export async function requestLoginOtp(input: {
  countryCode?: string;
  mobile?: string;
  email?: string;
  channel: OtpChannel;
  ip?: string | null;
}): Promise<OtpRequestResult & { maskedEmail?: string }> {
  const isPhoneLogin = Boolean(input.mobile && input.countryCode);
  const isEmailLogin = Boolean(input.email && !input.mobile);

  if (!isPhoneLogin && !isEmailLogin) {
    throw validationFailed("Either mobile number or email is required.");
  }

  let identifier: string; // phone or email
  let identifierForQuery: { type: "phone"; value: string } | { type: "email"; value: string };
  let userQueryCondition: any;
  let user: (typeof users.$inferSelect) | undefined;

  if (isPhoneLogin) {
    const parsed = parsePhone(input.countryCode!, input.mobile!);
    if (!parsed.ok) throw validationFailed(parsed.error);
    identifier = parsed.e164;
    identifierForQuery = { type: "phone", value: identifier };
    userQueryCondition = eq(users.phoneE164, identifier);
  } else {
    const email = input.email!.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw validationFailed("Invalid email address.");
    }
    identifier = email;
    identifierForQuery = { type: "email", value: identifier };
    userQueryCondition = eq(users.email, identifier);
  }

  const rules = await getRule("otp");
  const provider = getProvider(input.channel);
  if (input.channel === "SMS" && (!rules.smsEnabled || !provider?.isAvailable())) {
    throw validationFailed("Codes by SMS are not available yet. Please choose email.");
  }
  const activeProvider = provider ?? getProvider("EMAIL")!;

  const now = Date.now();
  const windowStart = new Date(now - rules.resendWindowMinutes * 60_000);
  const audit = (action: AuditAction, extra: object = {}) => {
    const newValue: any = { channel: input.channel, ...extra };
    if (identifierForQuery.type === "phone") {
      newValue.phone = maskPhone(identifier);
    } else {
      newValue.email = identifier.replace(/(.{2}).*(@.*)/, "$1***$2");
    }
    return recordAudit({
      action,
      entityType: "login_otp",
      newValue,
      ipAddress: input.ip ?? null,
    });
  };

  // Per-identifier throttling covers unknown identifiers too.
  const recentQuery = identifierForQuery.type === "phone"
    ? db.select({ createdAt: loginOtps.createdAt }).from(loginOtps).where(and(eq(loginOtps.phoneE164, identifier), gt(loginOtps.createdAt, windowStart)))
    : db.select({ createdAt: loginOtps.createdAt }).from(loginOtps).where(and(eq(loginOtps.email, identifier), gt(loginOtps.createdAt, windowStart)));

  const recent = await recentQuery.orderBy(desc(loginOtps.createdAt));

  const last = recent[0]?.createdAt.getTime();
  if (last !== undefined && now - last < rules.resendCooldownSeconds * 1000) {
    const wait = Math.ceil((rules.resendCooldownSeconds * 1000 - (now - last)) / 1000);
    await audit(AUDIT_ACTIONS.OTP_BLOCKED, { reason: "cooldown" });
    throw new AppError("RATE_LIMITED", `Please wait ${wait} seconds before requesting another code.`, {
      retryAfterSeconds: wait,
    });
  }
  if (recent.length >= rules.maxResendsPerWindow) {
    await audit(AUDIT_ACTIONS.OTP_BLOCKED, { reason: "window_limit" });
    throw new AppError("RATE_LIMITED", "Too many code requests for this identifier. Try again later.", {
      retryAfterSeconds: rules.resendWindowMinutes * 60,
    });
  }

  const [foundUser] = await db
    .select()
    .from(users)
    .where(and(userQueryCondition, isNull(users.deletedAt)));

  user = foundUser;
  const eligible = Boolean(user && user.status === "ACTIVE");

  // For email login with no account, ask user to create one first (no auto-create)
  // For phone login, check if user is registered
  let targetEmail = identifier;
  let maskedEmail: string | undefined;

  if (isPhoneLogin && user) {
    targetEmail = user.email;
  }

  if (isEmailLogin && user) {
    maskedEmail = identifier.replace(/(.{2}).*(@.*)/, "$1***$2");
  }

  const code = generateCode(rules.length);
  const salt = randomBytes(8).toString("hex");
  const id = await db.transaction(async (tx) => {
    if (eligible) {
      const supersedeCond = identifierForQuery.type === "phone"
        ? and(eq(loginOtps.phoneE164, identifier), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt))
        : and(eq(loginOtps.email, identifier), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt));

      await tx
        .update(loginOtps)
        .set({ supersededAt: new Date() })
        .where(supersedeCond);
    }

    const [row] = await tx
      .insert(loginOtps)
      .values({
        userId: eligible ? user!.id : null,
        ...(identifierForQuery.type === "phone" && { phoneE164: identifier }),
        ...(identifierForQuery.type === "email" && { email: identifier }),
        channel: activeProvider.channel,
        codeHash: hashCode(salt, identifier, eligible ? code : randomBytes(8).toString("hex")),
        expiresAt: new Date(now + rules.expiryMinutes * 60_000),
        maxAttempts: rules.maxAttempts,
        ipAddress: input.ip ?? null,
      })
      .returning({ id: loginOtps.id });
    return row.id;
  });

  await audit(AUDIT_ACTIONS.OTP_REQUESTED, { known: eligible, otpId: id });

  if (eligible) {
    // Not awaited: delivery time must not distinguish a known identifier from an unknown one.
    void activeProvider.send({ to: targetEmail, code, expiryMinutes: rules.expiryMinutes }).catch((error) => {
      console.error("[otp] delivery failed", error);
      void audit(AUDIT_ACTIONS.OTP_FAILED, { reason: "delivery_failed", otpId: id });
    });
  }

  return {
    message: OTP_REQUEST_ACK,
    channel: activeProvider.channel,
    resendAfterSeconds: rules.resendCooldownSeconds,
    ...(maskedEmail && { maskedEmail }),
  };
}

/** Returns the user on success; throws the same generic error for every failure. */
export async function verifyLoginOtp(input: {
  countryCode?: string;
  mobile?: string;
  email?: string;
  code: string;
  ip?: string | null;
}): Promise<User> {
  const fail = (): never => {
    throw new AppError("VALIDATION_FAILED", OTP_INVALID);
  };

  const isPhoneLogin = Boolean(input.mobile && input.countryCode);
  const isEmailLogin = Boolean(input.email && !input.mobile);

  if (!isPhoneLogin && !isEmailLogin) {
    return fail();
  }

  let identifier: string;
  let identifierType: "phone" | "email";

  if (isPhoneLogin) {
    const parsed = parsePhone(input.countryCode!, input.mobile!);
    if (!parsed.ok) return fail();
    identifier = parsed.e164;
    identifierType = "phone";
  } else {
    const email = input.email!.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail();
    }
    identifier = email;
    identifierType = "email";
  }

  const code = input.code.replace(/\s/g, "");
  if (!/^\d{4,8}$/.test(code)) return fail();

  const audit = (action: AuditAction, actorId: string | null, extra: object = {}) => {
    const newValue: any = { ...extra };
    if (identifierType === "phone") {
      newValue.phone = maskPhone(identifier);
    } else {
      newValue.email = identifier.replace(/(.{2}).*(@.*)/, "$1***$2");
    }
    return recordAudit({
      actorId,
      action,
      entityType: "login_otp",
      newValue,
      ipAddress: input.ip ?? null,
    });
  };

  const otpQueryCondition = identifierType === "phone"
    ? and(eq(loginOtps.phoneE164, identifier), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt))
    : and(eq(loginOtps.email, identifier), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt));

  const [otp] = await db
    .select()
    .from(loginOtps)
    .where(otpQueryCondition)
    .orderBy(desc(loginOtps.createdAt))
    .limit(1);

  if (!otp || otp.expiresAt.getTime() <= Date.now()) {
    await audit(AUDIT_ACTIONS.OTP_FAILED, null, { reason: otp ? "expired" : "none" });
    return fail();
  }

  // Count the attempt first, atomically; the cap therefore holds under concurrency.
  const [counted] = await db
    .update(loginOtps)
    .set({ attempts: sql`${loginOtps.attempts} + 1` })
    .where(
      and(
        eq(loginOtps.id, otp.id),
        isNull(loginOtps.consumedAt),
        sql`${loginOtps.attempts} < ${loginOtps.maxAttempts}`,
      ),
    )
    .returning({ attempts: loginOtps.attempts });
  if (!counted) {
    await audit(AUDIT_ACTIONS.OTP_BLOCKED, otp.userId, { reason: "max_attempts", otpId: otp.id });
    return fail();
  }

  if (!otp.userId || !matches(otp.codeHash, identifier, code)) {
    await audit(AUDIT_ACTIONS.OTP_FAILED, otp.userId, {
      reason: "mismatch",
      attempts: counted.attempts,
      otpId: otp.id,
    });
    return fail();
  }

  // Single use: only one concurrent verifier can flip consumed_at.
  const [used] = await db
    .update(loginOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(loginOtps.id, otp.id), isNull(loginOtps.consumedAt)))
    .returning({ id: loginOtps.id });
  if (!used) return fail();

  const [user] = await db.select().from(users).where(eq(users.id, otp.userId));
  if (!user || user.status !== "ACTIVE" || user.deletedAt) {
    await audit(AUDIT_ACTIONS.OTP_FAILED, otp.userId, { reason: "inactive_account", otpId: otp.id });
    return fail();
  }

  // SMS code proves phone possession; email-only login doesn't set phoneVerifiedAt
  if (otp.channel === "SMS" && identifierType === "phone" && !user.phoneVerifiedAt) {
    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
  }

  await audit(AUDIT_ACTIONS.OTP_VERIFIED, user.id, { channel: otp.channel, otpId: otp.id });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_SIGN_IN, user.id, {
    at: new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: getEnv().APP_TIMEZONE }),
  });
  return user;
}

/** Links (or replaces) the mobile number a signed-in user can log in with. */
export async function linkPhone(
  userId: string,
  role: User["role"],
  input: { countryCode: string; mobile: string },
): Promise<{ phoneE164: string }> {
  const parsed = parsePhone(input.countryCode, input.mobile);
  if (!parsed.ok) throw validationFailed(parsed.error);
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phoneE164, parsed.e164), isNull(users.deletedAt)));
  if (taken && taken.id !== userId) {
    throw new AppError("CONFLICT", "That mobile number is already linked to another account.");
  }
  await db
    .update(users)
    .set({ phoneE164: parsed.e164, phone: parsed.national, phoneVerifiedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.PHONE_LINKED,
    entityType: "user",
    entityId: userId,
    newValue: { phone: maskPhone(parsed.e164) },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED, userId, { action: "linked or changed" });
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
