/**
 * Flow spec v3, F18 (docs/flows-v3/wave5.md; flag flow_f18): linking or changing the account's mobile from My
 * Profile, first-time setup or the "add your mobile" prompt needs a code sent by SMS to the NEW number (purpose
 * PHONE_LINK). The number is then saved as verified, and the previous number (if any) gets a text message.
 *
 * In force whenever SMS codes can be sent on this server (owner 27-Nov-2026; before that, only with flag flow_f18). // DEFAULT – confirm with Sanjay:
 * where no SMS code can be sent (no SMS provider), the number is linked as today (unverified), so nobody is stuck.
 * Internal callers of linkPhone (shop registration, onboarding v2) are unchanged.
 */
import { and, eq, isNull, ne } from "drizzle-orm";

import { parseIndianMobile } from "@/lib/contact";
import { AppError, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { users, type UserRole } from "@/server/db/schema";
import { sendText } from "@/server/messaging/sms-whatsapp";
import { markPhoneVerified } from "@/server/otp/second-factor";
import { getOtpProvider } from "@/server/otp/providers";
import { auditOtp, consumeCode, issueCode, linkPhone } from "@/server/otp/service";
import { AUDIT_ACTIONS } from "@/server/services/audit";

export const PHONE_CODE_REQUIRED = "Enter the code we send by SMS to the new number.";

/**
 * The code is asked whenever SMS codes can be sent on this site (login & auth item 5, owner 27-Nov-2026: a mobile is
 * added or changed on My Profile only through an SMS code — no longer only with flag flow_f18).
 */
export async function phoneLinkNeedsCode(): Promise<boolean> {
  return (await getOtpProvider("SMS")) !== null;
}

function parse(mobile: string) {
  const parsed = parseIndianMobile(String(mobile ?? ""));
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { mobile: parsed.error } });
  return parsed;
}

async function loadUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new AppError("FORBIDDEN", "You do not have permission to do that.");
  return user;
}

/** POST /api/me/phone/code: an SMS code to the number about to be linked. */
export async function requestPhoneLinkCode(userId: string, mobile: string, ip: string | null): Promise<{ sentTo: string; resendAfterSeconds: number; expiryMinutes: number }> {
  if (!(await phoneLinkNeedsCode())) throw new AppError("CONFLICT", "No code is needed to add a mobile number on this site right now.");
  const user = await loadUser(userId);
  const { e164 } = parse(mobile);
  if (user.phoneE164 === e164 && user.phoneVerifiedAt) throw validationFailed("That is already your verified mobile number.");
  // No "taken" answer before the code: a number on another account is refused (and logged) once the code is right.
  const sent = await issueCode({ email: user.email, purpose: "PHONE_LINK", userId, phoneE164: e164, ip, bySms: true });
  return { sentTo: maskPhone(e164), ...sent };
}

/**
 * Links the mobile as the existing linkPhone does; while the code is needed, only with the right code, and the
 * number is then verified. Same number as now: nothing to do (no code asked).
 */
export async function linkPhoneChecked(
  userId: string,
  role: UserRole,
  input: { mobile: string; code?: string | null },
  ip: string | null = null,
): Promise<{ phoneE164: string }> {
  if (!(await phoneLinkNeedsCode())) return linkPhone(userId, role, { mobile: input.mobile });
  const before = await loadUser(userId);
  const { e164 } = parse(input.mobile);
  // Same number: nothing to do once verified; an unverified one is verified with its code (owner 27-Nov-2026).
  if (before.phoneE164 === e164 && before.phoneVerifiedAt) return { phoneE164: e164 };
  if (!input.code?.trim()) {
    throw validationFailed(PHONE_CODE_REQUIRED, { reason: "PHONE_CODE_REQUIRED", needsCode: true, fields: { code: PHONE_CODE_REQUIRED } });
  }
  await consumeCode({ email: before.email, purpose: "PHONE_LINK", code: input.code, ip, phoneE164: e164, userId });
  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: before.email, phoneE164: e164, actorId: userId, ip, purpose: "PHONE_LINK" });
  // The number belongs to another account: stop with the dual-auth message and log it for admin review.
  const [other] = await db.select({ id: users.id }).from(users).where(and(eq(users.phoneE164, e164), isNull(users.deletedAt), ne(users.id, userId)));
  if (other) {
    const { recordAccountConflict } = await import("@/server/dual-auth/verify");
    throw await recordAccountConflict(before, { kind: "MOBILE", otherUserId: other.id, value: e164, ip, where: "profile_phone" });
  }
  const linked = await linkPhone(userId, role, { mobile: input.mobile });
  await markPhoneVerified(await loadUser(userId), linked.phoneE164);
  // After the database work: the previous number is told (text message where they can be sent).
  if (before.phoneE164 && before.phoneE164 !== linked.phoneE164) {
    await sendText(
      "SMS",
      before.phoneE164,
      `GoKesari: this number was removed from a GoKesari account and replaced by ${maskPhone(linked.phoneE164)}. If this was not you, contact GoKesari support.`,
      "phone_changed_alert",
    ).catch((e) => console.error("[phone-link] old-number text not sent", e instanceof Error ? e.message : e));
  }
  return linked;
}
