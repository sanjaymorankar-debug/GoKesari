/**
 * Sensitive actions always ask BOTH factors, whatever the device (docs/dual-auth-2026-11, brief section 3):
 *   CONTACT_CHANGE      changing the mobile or e-mail (the new one is verified by its own code too)
 *   BANK_CHANGE         adding or changing a bank / UPI / payout account (any role)
 *   WITHDRAWAL          wallet withdrawal / cash-out, refund to bank
 *   TEAM_ROLE           role changes in "My team"
 *   OWNERSHIP_TRANSFER  shop ownership transfer (no such flow exists yet; the guard is ready for it)
 *
 * The person asks for the two codes (one by SMS to the verified mobile, one by e-mail to the verified address),
 * enters both, and may then do that action for rule dualAuth.stepUpMinutes (10). Each pass is bound to its action
 * (login_otps.step_up_request_id = "dual:<ACTION>") and to the account.
 * // DEFAULT – confirm with Sanjay: one pass covers repeats of the same action within the 10 minutes.
 *
 * Refusal: 403 { details: { reason: "DUAL_STEP_UP", stepUp: "DUAL", action, maskedPhone, maskedEmail } }; the
 * DualStepUp dialog (src/components/dual-verify/step-up-dialog.tsx) asks for the codes and retries.
 * Not in force (flag off / no SMS) → nothing is asked.
 */
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

import { AppError, forbidden } from "@/lib/errors";
import { maskEmailAddress } from "@/lib/contact";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { loginOtps, users, type User } from "@/server/db/schema";
import { consumeCode, issueCode } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { assertDualVerified, dualAuthInForce } from "./policy";

export const SENSITIVE_ACTIONS = ["CONTACT_CHANGE", "BANK_CHANGE", "WITHDRAWAL", "TEAM_ROLE", "OWNERSHIP_TRANSFER"] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export const STEP_UP_REQUIRED = "For your safety, confirm this with a code sent to your mobile by SMS and a code sent to your e-mail.";

const LABEL: Record<SensitiveAction, string> = {
  CONTACT_CHANGE: "change your mobile number or e-mail",
  BANK_CHANGE: "add or change a bank or payout account",
  WITHDRAWAL: "withdraw money",
  TEAM_ROLE: "change a role in your team",
  OWNERSHIP_TRANSFER: "transfer shop ownership",
};

export function isSensitiveAction(value: unknown): value is SensitiveAction {
  return typeof value === "string" && (SENSITIVE_ACTIONS as readonly string[]).includes(value);
}

const tag = (action: SensitiveAction) => `dual:${action}`;

async function loadUser(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.status !== "ACTIVE" || user.deletedAt) throw forbidden("This account cannot do that.");
  return user;
}

/** Both codes of this action verified within the window? */
async function hasPass(userId: string, action: SensitiveAction): Promise<boolean> {
  const { stepUpMinutes } = await getRule("dualAuth");
  const since = new Date(Date.now() - stepUpMinutes * 60_000);
  const passOf = (purpose: "STEP_UP_SMS" | "STEP_UP_EMAIL") =>
    db
      .select({ id: loginOtps.id })
      .from(loginOtps)
      .where(
        and(
          eq(loginOtps.userId, userId),
          eq(loginOtps.purpose, purpose),
          isNotNull(loginOtps.consumedAt),
          gt(loginOtps.consumedAt, since),
          eq(loginOtps.stepUpRequestId, tag(action)),
        ),
      )
      .orderBy(desc(loginOtps.consumedAt))
      .limit(1);
  const [[sms], [email]] = await Promise.all([passOf("STEP_UP_SMS"), passOf("STEP_UP_EMAIL")]);
  return Boolean(sms && email);
}

function refusal(user: User, action: SensitiveAction): AppError {
  return new AppError("FORBIDDEN", STEP_UP_REQUIRED, {
    reason: "DUAL_STEP_UP",
    stepUp: "DUAL",
    action,
    actionLabel: LABEL[action],
    maskedPhone: user.phoneE164 ? maskPhone(user.phoneE164) : null,
    maskedEmail: maskEmailAddress(user.email),
  });
}

/**
 * The guard the sensitive routes call before doing the action. Throws unless both codes for `action` were verified
 * in the last stepUpMinutes. A one-factor account first gets the DualVerify refusal (verify the missing factor).
 */
export async function requireDualStepUp(userId: string, action: SensitiveAction): Promise<void> {
  if (!(await dualAuthInForce())) return;
  await assertDualVerified(userId, "SENSITIVE");
  if (await hasPass(userId, action)) return;
  const user = await loadUser(userId);
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.DUAL_AUTH_STEP_UP_REQUIRED, entityType: "user", entityId: user.id, newValue: { action } });
  throw refusal(user, action);
}

/** Sends the two codes (SMS to the verified mobile, e-mail to the verified address). */
export async function startDualStepUp(userId: string, action: SensitiveAction, ip: string | null) {
  if (!(await dualAuthInForce())) throw new AppError("CONFLICT", "No extra codes are needed on this site right now.");
  await assertDualVerified(userId, "SENSITIVE");
  const user = await loadUser(userId);
  const sms = await issueCode({ email: user.email, purpose: "STEP_UP_SMS", userId: user.id, phoneE164: user.phoneE164, ip, bySms: true });
  const mail = await issueCode({ email: user.email, purpose: "STEP_UP_EMAIL", userId: user.id, phoneE164: null, ip });
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.DUAL_AUTH_STEP_UP_SENT, entityType: "user", entityId: user.id, newValue: { action }, ipAddress: ip });
  return {
    action,
    actionLabel: LABEL[action],
    maskedPhone: maskPhone(user.phoneE164!),
    maskedEmail: maskEmailAddress(user.email),
    resendAfterSeconds: Math.max(sms.resendAfterSeconds, mail.resendAfterSeconds),
    smsExpiryMinutes: sms.expiryMinutes,
    emailExpiryMinutes: mail.expiryMinutes,
  };
}

/** Checks both codes; on success the action may be done for stepUpMinutes. */
export async function verifyDualStepUp(userId: string, action: SensitiveAction, input: { smsCode: string; emailCode: string; ip: string | null }) {
  if (!(await dualAuthInForce())) return { action, validUntil: new Date() };
  const user = await loadUser(userId);
  // The e-mail code is checked (and used) only once the SMS code is known to be right, and a wrong e-mail code
  // leaves the SMS code valid — the person corrects one code without asking for new ones.
  let mail: { id: string } | null = null;
  const sms = await consumeCode({
    email: user.email,
    purpose: "STEP_UP_SMS",
    code: String(input.smsCode ?? ""),
    ip: input.ip,
    phoneE164: user.phoneE164,
    userId: user.id,
    beforeConsume: async () => {
      mail = await consumeCode({ email: user.email, purpose: "STEP_UP_EMAIL", code: String(input.emailCode ?? ""), ip: input.ip, userId: user.id });
    },
  });
  if (!mail) throw forbidden(STEP_UP_REQUIRED);
  await db.update(loginOtps).set({ stepUpRequestId: tag(action) }).where(eq(loginOtps.id, sms.id));
  await db.update(loginOtps).set({ stepUpRequestId: tag(action) }).where(eq(loginOtps.id, (mail as { id: string }).id));
  const { stepUpMinutes } = await getRule("dualAuth");
  const validUntil = new Date(Date.now() + stepUpMinutes * 60_000);
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DUAL_AUTH_STEP_UP_VERIFIED,
    entityType: "user",
    entityId: user.id,
    newValue: { action, validUntil: validUntil.toISOString() },
    ipAddress: input.ip,
  });
  return { action, validUntil };
}
