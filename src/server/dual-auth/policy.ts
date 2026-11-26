/**
 * DualVerify — the rule (docs/dual-auth-2026-11; owner brief 26-Nov-2026 23.28 IST; flag dual_auth; migration 0219).
 *
 * An account counts only when BOTH factors are verified:
 *   - mobile: an SMS code to the number (users.phone_verified_at);
 *   - e-mail: an e-mailed code, the e-mailed one-time link, or Google with email_verified = true (Auth.js only links
 *     a Google account whose address Google verified) on a real address (users.email_verified, or a google row in
 *     accounts; never a placeholder address).
 *
 * In force = flag dual_auth on AND SMS codes can be sent on this server. // DEFAULT – confirm with Sanjay: with the
 * flag on but no SMS provider (gokesari.com before SMSFortius keys are set), nothing is asked — nobody can be locked
 * out — and Admin → Sign-in security shows "on, but not in force".
 *
 * This file only reads state; it never sends a code (verify.ts, step-up.ts and devices.ts do).
 */
import { and, eq } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { maskEmailAddress } from "@/lib/contact";
import { maskPhone } from "@/lib/phone";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { db } from "@/server/db";
import { accounts, users, type User, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getOtpProvider } from "@/server/otp/providers";

export const DUAL_AUTH_FLAG = "dual_auth" as const;
/** The DualVerify page: verifies the missing factor(s) and comes back to `?return=`. */
export const DUAL_VERIFY_PATH = "/account/verify";

export const DUAL_AUTH_REQUIRED = "Please verify both your mobile number and your e-mail to continue.";
export const DIFFERENT_ACCOUNTS = "This mobile and email belong to different accounts. Log in with one, or contact support.";

/**
 * Roles that may sign in with one factor on a device they trusted (both factors done there in the last 30 days).
 * Every other role — admin, operator and all staff roles — gives both factors on every sign-in.
 * // DEFAULT – confirm with Sanjay: delivery partners and society admins are treated like customers / shop owners;
 * every internal staff role (CA, accountant, support, operations, dealership staff) like admin / operator.
 */
export const DEVICE_TRUST_ROLES: readonly UserRole[] = ["CUSTOMER", "SHOP_OWNER", "DEALER", "DELIVERY_PARTNER", "SOCIETY_ADMIN"];

export function isStaffRole(role: UserRole): boolean {
  return !DEVICE_TRUST_ROLES.includes(role);
}

export async function dualAuthFlagOn(): Promise<boolean> {
  return isFeatureEnabled(DUAL_AUTH_FLAG).catch(() => false);
}

/** The rule is really applied on this server: flag on and SMS codes available. */
export async function dualAuthInForce(): Promise<boolean> {
  if (!(await dualAuthFlagOn())) return false;
  return (await getOtpProvider("SMS")) !== null;
}

export type Factor = "MOBILE" | "EMAIL";

export interface FactorState {
  mobileVerified: boolean;
  emailVerified: boolean;
  /** The account's e-mail is a placeholder (registered with a mobile number alone). */
  placeholderEmail: boolean;
  missing: Factor[];
  maskedPhone: string | null;
  maskedEmail: string | null;
}

export function hasRealEmail(user: Pick<User, "email" | "emailPlaceholder">): boolean {
  return !user.emailPlaceholder && !isPlaceholderEmail(user.email);
}

/** E-mail verified: by a code or link (email_verified), or Google (the accounts row). Never a placeholder. */
export async function emailFactorVerified(user: Pick<User, "id" | "email" | "emailPlaceholder" | "emailVerified">): Promise<boolean> {
  if (!hasRealEmail(user)) return false;
  if (user.emailVerified) return true;
  const [google] = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.provider, "google")))
    .limit(1);
  return Boolean(google);
}

export function mobileFactorVerified(user: Pick<User, "phoneE164" | "phoneVerifiedAt">): boolean {
  return Boolean(user.phoneE164 && user.phoneVerifiedAt);
}

export async function factorState(user: User): Promise<FactorState> {
  const emailVerified = await emailFactorVerified(user);
  const mobileVerified = mobileFactorVerified(user);
  const placeholderEmail = !hasRealEmail(user);
  return {
    mobileVerified,
    emailVerified,
    placeholderEmail,
    missing: [...(mobileVerified ? [] : (["MOBILE"] as const)), ...(emailVerified ? [] : (["EMAIL"] as const))],
    maskedPhone: user.phoneE164 ? maskPhone(user.phoneE164) : null,
    maskedEmail: placeholderEmail ? null : maskEmailAddress(user.email),
  };
}

async function loadUser(userId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

/**
 * Keeps users.needs_second_factor (the migration's mark, the admin report) in step with the account's factors.
 * Called after every verification; returns the fresh state.
 */
export async function syncNeedsSecondFactor(userOrId: User | string): Promise<FactorState | null> {
  const user = typeof userOrId === "string" ? await loadUser(userOrId) : userOrId;
  if (!user) return null;
  const state = await factorState(user);
  const needs = state.missing.length > 0;
  if (needs !== user.needsSecondFactor) {
    await db
      .update(users)
      .set({ needsSecondFactor: needs, needsSecondFactorSince: needs ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  return state;
}

/** What a one-factor account is about to do (audit and the message). */
export type GatedAction = "ORDER" | "SHOP" | "DEALER" | "WITHDRAW" | "ADMIN" | "TEAM" | "SENSITIVE" | "RIDER";

export function verifyPathFor(returnTo?: string | null): string {
  const safe = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : null;
  return safe ? `${DUAL_VERIFY_PATH}?return=${encodeURIComponent(safe)}` : DUAL_VERIFY_PATH;
}

export function dualAuthRequiredError(state: FactorState, action: GatedAction, returnTo?: string | null): AppError {
  return new AppError("FORBIDDEN", DUAL_AUTH_REQUIRED, {
    reason: "DUAL_AUTH_REQUIRED",
    dualAuth: "NEEDS_SECOND_FACTOR",
    action,
    missing: state.missing,
    verifyUrl: verifyPathFor(returnTo),
  });
}

/**
 * The gate for orders, shop / dealer / admin work and withdrawals: a one-factor account is refused (403,
 * details.dualAuth = NEEDS_SECOND_FACTOR, details.verifyUrl) until it verifies the missing factor. Browsing never
 * calls this. Not in force → nothing happens.
 */
export async function assertDualVerified(userId: string, action: GatedAction, returnTo?: string | null): Promise<void> {
  if (!(await dualAuthInForce())) return;
  const user = await loadUser(userId);
  if (!user) return;
  const state = await syncNeedsSecondFactor(user);
  if (!state || state.missing.length === 0) return;
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DUAL_AUTH_GATE_BLOCKED,
    entityType: "user",
    entityId: user.id,
    newValue: { action, missing: state.missing },
  });
  throw dualAuthRequiredError(state, action, returnTo);
}

/** For pages and layouts: where to send a one-factor account (null = nothing to do). */
export async function dualVerifyRedirect(userId: string, returnTo: string): Promise<string | null> {
  if (!(await dualAuthInForce())) return null;
  const user = await loadUser(userId);
  if (!user) return null;
  const state = await syncNeedsSecondFactor(user);
  return state && state.missing.length > 0 ? verifyPathFor(returnTo) : null;
}

/** For the site banner: the factors this account still has to verify (empty when none or not in force). */
export async function missingFactorsForBanner(userId: string): Promise<Factor[]> {
  if (!(await dualAuthInForce())) return [];
  const user = await loadUser(userId);
  if (!user) return [];
  return (await factorState(user)).missing;
}

/* ------------------------------------------------- riders (docs/flows-v3, flag flow_f1) */

/** docs/flows-v3/wave1.md (F1 → F11): rider application and rider pages ask for both factors while flow_f1 is on. */
export async function riderDualGateOn(): Promise<boolean> {
  return isFeatureEnabled("flow_f1").catch(() => false);
}

/** The rider gate for APIs: as assertDualVerified (needs dual_auth in force too); nothing while flow_f1 is off. */
export async function assertRiderDualVerified(userId: string, returnTo?: string | null): Promise<void> {
  if (!(await riderDualGateOn())) return;
  await assertDualVerified(userId, "RIDER", returnTo);
}

/** The rider gate for pages: where to send a one-factor account (null = nothing to do, or flow_f1 off). */
export async function riderDualVerifyRedirect(userId: string, returnTo: string): Promise<string | null> {
  if (!(await riderDualGateOn())) return null;
  return dualVerifyRedirect(userId, returnTo);
}
