/**
 * Admin → Sign-in security (docs/sms-2fa-2026-11). ADMIN only.
 *
 *  - SMS sign-in code: one switch per audience (customers, shop owners), saved
 *    through setFeatureFlag (reason required, logged in feature_flag_changes and
 *    the audit log; four-eye approval when rbac_v2_four_eye_admin is on — the
 *    route decides that, as the feature-flags route does).
 *  - Checkout code: rule checkoutOtp through setRule (audited).
 *  - Status: SMS provider (never its keys), verified mobiles, recent lockouts.
 *
 * A switch that is on while SMS codes cannot be sent asks nothing: the page
 * says so ("on, but not in force").
 */
import { and, count, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import { getEnv, messagingConfigProblem, msg91ConfigProblem } from "@/lib/env";
import { forbidden, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { auditLogs, users, type FeatureFlagKey, type UserRole } from "@/server/db/schema";
import { smsOtpMode } from "@/server/messaging/sms-whatsapp";
import type { RuleValue } from "@/server/config/rules";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { getFeatureFlags, listFeatureFlagChanges, setFeatureFlag } from "@/server/services/feature-flags";
import { getRule, setRule } from "@/server/services/settings";
import { smsCodesAvailable } from "./second-factor";

export const SIGN_IN_AUDIENCES = {
  customers: { flag: "sms_otp_signin_customers_enabled", role: "CUSTOMER", label: "Customers: email + SMS code at sign-in" },
  shopOwners: { flag: "sms_otp_signin_shop_owners_enabled", role: "SHOP_OWNER", label: "Shop owners: email + SMS code at sign-in" },
} as const satisfies Record<string, { flag: FeatureFlagKey; role: UserRole; label: string }>;
export type SignInAudience = keyof typeof SIGN_IN_AUDIENCES;

export interface SmsProviderStatus {
  mode: "none" | "mock" | "msg91";
  /** SMS_PROVIDER as configured (msg91 with a missing key shows mode none + the problem). */
  configured: string;
  problem: string | null;
  ruleSmsEnabled: boolean;
  /** Codes can be sent by SMS right now. */
  available: boolean;
}

export async function smsProviderStatus(): Promise<SmsProviderStatus> {
  const env = getEnv();
  const mode = smsOtpMode();
  const ruleSmsEnabled = (await getRule("otp")).smsEnabled;
  let problem: string | null = null;
  if (env.SMS_PROVIDER === "none") problem = "No SMS provider is set on this server (SMS_PROVIDER=none).";
  else if (env.SMS_PROVIDER === "msg91") problem = msg91ConfigProblem(env);
  else problem = messagingConfigProblem(env);
  if (!problem && !ruleSmsEnabled) problem = "Rule otp.smsEnabled is off: one-time codes are not sent by SMS.";
  return { mode, configured: env.SMS_PROVIDER, problem, ruleSmsEnabled, available: await smsCodesAvailable() };
}

export interface SignInSecurityOverview {
  provider: SmsProviderStatus;
  audiences: {
    audience: SignInAudience;
    flag: FeatureFlagKey;
    label: string;
    enabled: boolean;
    /** On AND SMS available: the audience is really asked. */
    inForce: boolean;
    lastChange: { byEmail: string | null; at: Date; reason: string; enabled: boolean } | null;
  }[];
  checkout: RuleValue<"checkoutOtp"> & { inForce: boolean };
  stats: {
    customers: { total: number; verifiedMobile: number };
    shopOwners: { total: number; verifiedMobile: number };
    lockouts24h: number;
    lockouts7d: number;
    smsCodesSent24h: number;
  };
}

async function countRole(role: UserRole) {
  const live = and(eq(users.role, role), isNull(users.deletedAt));
  const [{ total }] = await db.select({ total: count() }).from(users).where(live);
  const [{ verified }] = await db.select({ verified: count() }).from(users).where(and(live, isNotNull(users.phoneVerifiedAt)));
  return { total: Number(total), verifiedMobile: Number(verified) };
}

async function countAudit(action: string, since: Date, extra = sql`true`) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), gt(auditLogs.createdAt, since), extra));
  return Number(n);
}

export async function signInSecurityOverview(): Promise<SignInSecurityOverview> {
  const [provider, flags, checkout] = await Promise.all([smsProviderStatus(), getFeatureFlags(), getRule("checkoutOtp")]);
  const audiences = await Promise.all(
    (Object.keys(SIGN_IN_AUDIENCES) as SignInAudience[]).map(async (audience) => {
      const { flag, label } = SIGN_IN_AUDIENCES[audience];
      const [last] = await listFeatureFlagChanges({ key: flag, limit: 1 });
      const enabled = flags[flag].enabled;
      return {
        audience,
        flag,
        label,
        enabled,
        inForce: enabled && provider.available,
        lastChange: last ? { byEmail: last.changedByEmail, at: last.changedAt, reason: last.reason, enabled: last.newValue.enabled } : null,
      };
    }),
  );
  const now = Date.now();
  const day = new Date(now - 24 * 3_600_000);
  const week = new Date(now - 7 * 24 * 3_600_000);
  const maxAttempts = sql`${auditLogs.newValue}->>'reason' = 'max_attempts'`;
  const bySms = sql`${auditLogs.newValue}->>'purpose' IN ('LOGIN_SMS', 'CHECKOUT')`;
  const [customers, shopOwners, lockouts24h, lockouts7d, smsCodesSent24h] = await Promise.all([
    countRole("CUSTOMER"),
    countRole("SHOP_OWNER"),
    countAudit(AUDIT_ACTIONS.OTP_BLOCKED, day, maxAttempts),
    countAudit(AUDIT_ACTIONS.OTP_BLOCKED, week, maxAttempts),
    countAudit(AUDIT_ACTIONS.OTP_REQUESTED, day, bySms),
  ]);
  return {
    provider,
    audiences,
    checkout: { ...checkout, inForce: checkout.enabled && provider.available },
    stats: { customers, shopOwners, lockouts24h, lockouts7d, smsCodesSent24h },
  };
}

/** Switches one audience's SMS sign-in code (no four-eye here: the route asks for approval first when it is on). */
export async function setSignInSmsCode(
  audience: SignInAudience,
  enabled: boolean,
  reason: string,
  actor: { id: string; role: UserRole; email?: string | null },
) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change sign-in security.");
  const target = SIGN_IN_AUDIENCES[audience];
  if (!target) throw validationFailed("Unknown audience.");
  return setFeatureFlag(target.flag, { enabled, districtCodes: null }, reason, actor);
}

export async function setCheckoutCode(
  value: { enabled: boolean; mode: "every_checkout" | "once_per_hours"; hours: number },
  actor: { id: string; role: UserRole },
) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change sign-in security.");
  return setRule("checkoutOtp", value, actor);
}
