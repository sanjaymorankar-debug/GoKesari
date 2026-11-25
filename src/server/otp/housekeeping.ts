/**
 * Deleting old one-time codes (batch-2026-10 WS-A, F1.1.2 / GS-074).
 * A code is only a salted HMAC, but there is no reason to keep it once it is
 * expired or used: rows older than `otpHousekeeping.retainHours` (and older
 * than the otp resend window, which counts recent codes for the rate limits)
 * are deleted. Every request / success / failure stays in the audit log.
 */
import { and, lt } from "drizzle-orm";

import { db } from "@/server/db";
import { loginOtps } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

export async function purgeExpiredOtps(now: Date = new Date()): Promise<{ deleted: number; skipped?: "disabled" }> {
  const housekeeping = await getRule("otpHousekeeping");
  if (!housekeeping.purgeEnabled) return { deleted: 0, skipped: "disabled" };
  const otp = await getRule("otp");
  // docs/sms-2fa-2026-11: a verified checkout code covers orders for checkoutOtp.hours (once_per_hours mode).
  const checkoutOtp = await getRule("checkoutOtp");
  const checkoutKeepMs = checkoutOtp.enabled && checkoutOtp.mode === "once_per_hours" ? checkoutOtp.hours * 3_600_000 : 0;
  const keepMs = Math.max(housekeeping.retainHours * 3_600_000, otp.resendWindowMinutes * 60_000, checkoutKeepMs);
  const before = new Date(now.getTime() - keepMs);
  const deleted = await db
    .delete(loginOtps)
    .where(and(lt(loginOtps.expiresAt, before), lt(loginOtps.createdAt, before)))
    .returning({ id: loginOtps.id });
  if (deleted.length > 0) {
    await recordAudit({
      action: AUDIT_ACTIONS.OTP_PURGED,
      entityType: "login_otp",
      newValue: { deleted: deleted.length, olderThan: before.toISOString() },
    });
  }
  return { deleted: deleted.length };
}
