/**
 * docs/dual-auth-2026-11: Admin → Dual authentication — the numbers, the shops whose owner has no verified e-mail
 * (registered with a mobile number alone), accounts in conflict for operator review, and the audit trail
 * (verifications, sign-ins, device trust, two-code checks) shown in IST.
 */
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";

import { maskEmailAddress } from "@/lib/contact";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { auditLogs, shops, users } from "@/server/db/schema";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { getOtpProvider } from "@/server/otp/providers";
import { needsSecondFactorCounts } from "./reminders";

export const DUAL_AUTH_AUDIT_ACTIONS = [
  "auth.dual_factor_verified",
  "auth.dual_sign_in",
  "auth.device_trusted",
  "auth.devices_revoked",
  "auth.step_up_sent",
  "auth.step_up_verified",
  "auth.step_up_required",
  "auth.account_conflict",
  "auth.dual_gate_blocked",
  "auth.second_factor_reminder",
  "auth.otp_blocked",
] as const;

export function formatIst(at: Date | null | undefined): string {
  if (!at) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")} ${get("hour")}.${get("minute")} IST`;
}

export async function dualAuthReport() {
  const [flag, sms, counts] = await Promise.all([getFeatureFlag("dual_auth"), getOtpProvider("SMS"), needsSecondFactorCounts()]);
  const mobileOnlyShops = await db
    .select({
      shopId: shops.id,
      shopName: shops.name,
      status: shops.status,
      ownerId: users.id,
      phone: users.phoneE164,
      remindedAt: users.secondFactorRemindedAt,
      since: users.needsSecondFactorSince,
    })
    .from(shops)
    .innerJoin(users, eq(users.id, shops.ownerId))
    .where(and(isNull(shops.deletedAt), eq(users.needsSecondFactor, true), eq(users.emailPlaceholder, true), inArray(shops.status, ["APPROVED", "PENDING_APPROVAL", "SUSPENDED"])))
    .orderBy(shops.name)
    .limit(500);
  const oneFactorShops = await db
    .select({ shopId: shops.id, shopName: shops.name, status: shops.status, ownerId: users.id, email: users.email, placeholder: users.emailPlaceholder, phone: users.phoneE164, phoneVerifiedAt: users.phoneVerifiedAt })
    .from(shops)
    .innerJoin(users, eq(users.id, shops.ownerId))
    .where(and(isNull(shops.deletedAt), eq(users.needsSecondFactor, true), eq(users.emailPlaceholder, false)))
    .orderBy(shops.name)
    .limit(500);
  const conflicts = await db
    .select({ id: auditLogs.id, at: auditLogs.createdAt, actorId: auditLogs.actorId, value: auditLogs.newValue, ip: auditLogs.ipAddress })
    .from(auditLogs)
    .where(eq(auditLogs.action, "auth.account_conflict"))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
  const events = await db
    .select({ id: auditLogs.id, at: auditLogs.createdAt, action: auditLogs.action, actorId: auditLogs.actorId, entityId: auditLogs.entityId, value: auditLogs.newValue, ip: auditLogs.ipAddress })
    .from(auditLogs)
    .where(inArray(auditLogs.action, [...DUAL_AUTH_AUDIT_ACTIONS]))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
  const otpEvents = await db
    .select({ id: auditLogs.id, at: auditLogs.createdAt, action: auditLogs.action, value: auditLogs.newValue })
    .from(auditLogs)
    .where(like(auditLogs.action, "auth.otp_%"))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);
  return {
    flagOn: flag.enabled,
    smsAvailable: sms !== null,
    inForce: flag.enabled && sms !== null,
    counts,
    mobileOnlyShops: mobileOnlyShops.map((r) => ({ ...r, phone: r.phone ? maskPhone(r.phone) : "—" })),
    oneFactorShops: oneFactorShops.map((r) => ({
      ...r,
      email: r.placeholder ? "—" : maskEmailAddress(r.email),
      phone: r.phone ? maskPhone(r.phone) : "—",
      missing: [r.phoneVerifiedAt ? null : "mobile", "e-mail"].filter(Boolean).join(" + "),
    })),
    conflicts,
    events,
    otpEvents,
  };
}
