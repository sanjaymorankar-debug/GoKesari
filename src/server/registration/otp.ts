/**
 * One-time codes for shop self-registration (Module 3): proves the applicant
 * holds the mobile number before anything is saved. Sent by SMS only (there
 * is no account and no email yet); stored as an HMAC in login_otps with
 * purpose SHOP_REGISTRATION, single use, limited attempts and resends, using
 * the same `otp` rule as sign-in.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { AppError, validationFailed } from "@/lib/errors";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { loginOtps } from "@/server/db/schema";
import { isTextChannelAvailable, sendText } from "@/server/messaging/sms-whatsapp";
import { getRule } from "@/server/services/settings";

export const REGISTRATION_OTP_INVALID = "That code is wrong or has expired. Request a new code.";

function hash(salt: string, mobileE164: string, code: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`${salt}:shop-registration:${mobileE164}:${code}`).digest("hex");
  return `${salt}:${mac}`;
}

function matches(stored: string, mobileE164: string, code: string): boolean {
  const [salt] = stored.split(":");
  if (!salt) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(hash(salt, mobileE164, code));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function sendRegistrationOtp(mobileE164: string, ip: string | null): Promise<{ resendAfterSeconds: number; expiryMinutes: number }> {
  if (!isTextChannelAvailable("SMS")) {
    throw new AppError("CONFLICT", "Registration by mobile is not available right now (SMS is not set up). Please try again later.");
  }
  const rules = await getRule("otp");
  enforceRateLimit(`reg-otp-mobile:${mobileE164}`, { limit: rules.maxResendsPerWindow, windowMs: rules.resendWindowMinutes * 60_000 });
  if (ip) enforceRateLimit(`reg-otp-ip:${ip}`, { limit: 20, windowMs: 60 * 60_000 });
  const now = Date.now();
  const [last] = await db
    .select({ createdAt: loginOtps.createdAt })
    .from(loginOtps)
    .where(and(eq(loginOtps.phoneE164, mobileE164), eq(loginOtps.purpose, "SHOP_REGISTRATION"), gt(loginOtps.createdAt, new Date(now - rules.resendWindowMinutes * 60_000))))
    .orderBy(desc(loginOtps.createdAt))
    .limit(1);
  if (last && now - last.createdAt.getTime() < rules.resendCooldownSeconds * 1000) {
    const wait = Math.ceil((rules.resendCooldownSeconds * 1000 - (now - last.createdAt.getTime())) / 1000);
    throw new AppError("RATE_LIMITED", `Please wait ${wait} seconds before requesting another code.`, { retryAfterSeconds: wait });
  }
  let code = "";
  for (let i = 0; i < rules.length; i++) code += String(randomInt(0, 10));
  const salt = randomBytes(8).toString("hex");
  await db.transaction(async (tx) => {
    await tx
      .update(loginOtps)
      .set({ supersededAt: new Date() })
      .where(and(eq(loginOtps.phoneE164, mobileE164), eq(loginOtps.purpose, "SHOP_REGISTRATION"), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt)));
    await tx.insert(loginOtps).values({
      phoneE164: mobileE164,
      email: null,
      purpose: "SHOP_REGISTRATION",
      channel: "SMS",
      codeHash: hash(salt, mobileE164, code),
      expiresAt: new Date(now + rules.expiryMinutes * 60_000),
      maxAttempts: rules.maxAttempts,
      ipAddress: ip,
    });
  });
  await sendText("SMS", mobileE164, `${code} is your GoKesari shop registration code. It expires in ${rules.expiryMinutes} minutes. Do not share it.`, "registration-otp");
  return { resendAfterSeconds: rules.resendCooldownSeconds, expiryMinutes: rules.expiryMinutes };
}

/** Checks and consumes the latest code for the number. Throws the same message for every failure. */
export async function verifyRegistrationOtp(mobileE164: string, code: string): Promise<Date> {
  if (!/^\d{4,8}$/.test(code.trim())) throw validationFailed(REGISTRATION_OTP_INVALID);
  const [otp] = await db
    .select()
    .from(loginOtps)
    .where(and(eq(loginOtps.phoneE164, mobileE164), eq(loginOtps.purpose, "SHOP_REGISTRATION"), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt)))
    .orderBy(desc(loginOtps.createdAt))
    .limit(1);
  if (!otp || otp.expiresAt.getTime() < Date.now() || otp.attempts >= otp.maxAttempts) throw validationFailed(REGISTRATION_OTP_INVALID);
  const [counted] = await db
    .update(loginOtps)
    .set({ attempts: otp.attempts + 1 })
    .where(and(eq(loginOtps.id, otp.id), eq(loginOtps.attempts, otp.attempts)))
    .returning({ attempts: loginOtps.attempts });
  if (!counted || !matches(otp.codeHash, mobileE164, code.trim())) throw validationFailed(REGISTRATION_OTP_INVALID);
  const [used] = await db
    .update(loginOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(loginOtps.id, otp.id), isNull(loginOtps.consumedAt)))
    .returning({ at: loginOtps.consumedAt });
  if (!used?.at) throw validationFailed(REGISTRATION_OTP_INVALID);
  return used.at;
}
