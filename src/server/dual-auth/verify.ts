/**
 * DualVerify — completing a missing factor on a signed-in account (docs/dual-auth-2026-11).
 *
 * Used by the DualVerify page (/account/verify), the checkout login sheet and the shop identity step:
 *   - mobile: a 6-digit SMS code to the number (purpose DUAL_VERIFY_SMS), saved with phone_verified_at;
 *   - e-mail: a 6-digit code to the address (purpose DUAL_VERIFY_EMAIL) — the account's own address, or, for an
 *     account registered with a mobile number alone (placeholder e-mail), the address the owner gives now.
 *     (The e-mailed sign-in link and Google are the other two ways; they run through Auth.js on sign-in.)
 *
 * Account check (brief D): only once the code proved the number / address. If it already belongs to ANOTHER account
 * the step stops with DIFFERENT_ACCOUNTS and an auth.account_conflict audit row (Admin → Dual authentication lists
 * them for operator review). Before that, the replies are the same whether or not a number / address is registered.
 *
 * Both factors done → needs_second_factor cleared and this browser trusted (devices.ts).
 */
import { and, eq, isNull, ne } from "drizzle-orm";

import { isValidEmail, maskEmailAddress, normalizeEmail, parseIndianMobile } from "@/lib/contact";
import { AppError, conflict, forbidden, isUniqueViolation, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { users, type User } from "@/server/db/schema";
import { markPhoneVerified } from "@/server/otp/second-factor";
import { auditOtp, consumeCode, issueCode } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { revokeTrustedDevices, trustThisDevice } from "./devices";
import { requireDualStepUp } from "./step-up";
import { DIFFERENT_ACCOUNTS, factorState, hasRealEmail, mobileFactorVerified, syncNeedsSecondFactor, type FactorState } from "./policy";

async function loadLiveUser(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user || user.status !== "ACTIVE") throw forbidden("This account cannot be verified.");
  return user;
}

function parseMobileOrRefuse(mobile: string | null | undefined): string {
  const parsed = parseIndianMobile(String(mobile ?? ""));
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { mobile: parsed.error } });
  return parsed.e164;
}

function parseEmailOrRefuse(email: string | null | undefined): string {
  const value = String(email ?? "").trim();
  if (!isValidEmail(value)) throw validationFailed("Enter a valid email address, e.g. name@example.com.", { fields: { email: "Enter a valid email." } });
  return normalizeEmail(value);
}

/** Logged for operator review; the person sees DIFFERENT_ACCOUNTS. */
export async function recordAccountConflict(user: User, detail: { kind: "MOBILE" | "EMAIL"; otherUserId: string; value: string; ip: string | null; where: string }) {
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DUAL_AUTH_ACCOUNT_CONFLICT,
    entityType: "user",
    entityId: user.id,
    newValue: {
      kind: detail.kind,
      otherUserId: detail.otherUserId,
      value: detail.kind === "MOBILE" ? maskPhone(detail.value) : maskEmailAddress(detail.value),
      where: detail.where,
      status: "OPEN",
    },
    ipAddress: detail.ip,
  });
  return conflict(DIFFERENT_ACCOUNTS, { reason: "DIFFERENT_ACCOUNTS" });
}

async function otherOwnerOfPhone(e164: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phoneE164, e164), isNull(users.deletedAt), ne(users.id, userId)));
  return row?.id ?? null;
}

async function otherOwnerOfEmail(email: string, userId: string): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, userId)));
  return row?.id ?? null;
}

async function afterFactor(user: User, factor: "MOBILE" | "EMAIL", ip: string | null, where: string): Promise<FactorState> {
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DUAL_AUTH_FACTOR_VERIFIED,
    entityType: "user",
    entityId: user.id,
    newValue: { factor, where },
    ipAddress: ip,
  });
  const state = (await syncNeedsSecondFactor(user.id))!;
  if (state.missing.length === 0) {
    await trustThisDevice(user.id, `both factors (${where})`).catch((e) => console.error("[dual-auth] trust device", e));
    // Shops held because the owner had one factor go live now (if every other rule allows).
    const { releaseShopsHeldForDualAuth } = await import("@/server/services/shops");
    await releaseShopsHeldForDualAuth(user.id).catch((e) => console.error("[dual-auth] release shops", e));
  }
  return state;
}

/* ---------------------------------------------------------------- mobile */

export interface CodeSent {
  sentTo: string;
  resendAfterSeconds: number;
  expiryMinutes: number;
}

/**
 * Sends the SMS code. `mobile` is the number to verify; an account whose mobile is already verified needs none
 * (nothing is sent). No "this number is taken" answer here (brief 5): that is decided after the code.
 */
export async function sendMobileFactorCode(userId: string, mobile: string | null | undefined, ip: string | null): Promise<CodeSent> {
  const user = await loadLiveUser(userId);
  const e164 = mobile?.trim() ? parseMobileOrRefuse(mobile) : user.phoneE164;
  if (!e164) throw validationFailed("Enter your 10-digit mobile number.", { needsPhone: true, fields: { mobile: "Enter your mobile number." } });
  if (mobileFactorVerified(user) && user.phoneE164 === e164) throw conflict("Your mobile number is already verified.");
  // A different number on an account whose mobile is verified is a change: both factors first (brief 3).
  if (mobileFactorVerified(user)) await requireDualStepUp(user.id, "CONTACT_CHANGE");
  const sent = await issueCode({ email: user.email, purpose: "DUAL_VERIFY_SMS", userId: user.id, phoneE164: e164, ip, bySms: true });
  return { sentTo: maskPhone(e164), ...sent };
}

export async function confirmMobileFactorCode(userId: string, mobile: string | null | undefined, code: string, ip: string | null, where = "verify_page"): Promise<FactorState> {
  const user = await loadLiveUser(userId);
  const e164 = mobile?.trim() ? parseMobileOrRefuse(mobile) : user.phoneE164;
  if (!e164) throw validationFailed("Enter your 10-digit mobile number.", { needsPhone: true });
  const changing = mobileFactorVerified(user) && user.phoneE164 !== e164;
  if (changing) await requireDualStepUp(user.id, "CONTACT_CHANGE");
  await consumeCode({ email: user.email, purpose: "DUAL_VERIFY_SMS", code: String(code ?? ""), ip, phoneE164: e164, userId: user.id });
  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: user.email, phoneE164: e164, actorId: user.id, ip, purpose: "DUAL_VERIFY_SMS" });
  const other = await otherOwnerOfPhone(e164, user.id);
  if (other) throw await recordAccountConflict(user, { kind: "MOBILE", otherUserId: other, value: e164, ip, where });
  try {
    await markPhoneVerified(user, e164);
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT") {
      const again = await otherOwnerOfPhone(e164, user.id);
      if (again) throw await recordAccountConflict(user, { kind: "MOBILE", otherUserId: again, value: e164, ip, where });
    }
    throw error;
  }
  if (changing) await revokeTrustedDevices(user.id, "mobile_changed");
  return afterFactor(user, "MOBILE", ip, where);
}

/* ---------------------------------------------------------------- e-mail */

/**
 * Sends the e-mail code: to the account's own address, or — an account with a placeholder address (mobile-only
 * registration) — to the address given now. No "address taken" answer before the code.
 */
export async function sendEmailFactorCode(userId: string, email: string | null | undefined, ip: string | null): Promise<CodeSent> {
  const user = await loadLiveUser(userId);
  const target = hasRealEmail(user) ? user.email : parseEmailOrRefuse(email);
  const state = await factorState(user);
  if (state.emailVerified) throw conflict("Your e-mail is already verified.");
  const sent = await issueCode({ email: target, purpose: "DUAL_VERIFY_EMAIL", userId: user.id, phoneE164: null, ip });
  return { sentTo: maskEmailAddress(target), ...sent };
}

export async function confirmEmailFactorCode(userId: string, email: string | null | undefined, code: string, ip: string | null, where = "verify_page"): Promise<FactorState> {
  const user = await loadLiveUser(userId);
  const target = hasRealEmail(user) ? user.email : parseEmailOrRefuse(email);
  await consumeCode({ email: target, purpose: "DUAL_VERIFY_EMAIL", code: String(code ?? ""), ip, userId: user.id });
  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: target, actorId: user.id, ip, purpose: "DUAL_VERIFY_EMAIL" });
  if (target !== user.email) {
    const other = await otherOwnerOfEmail(target, user.id);
    if (other) throw await recordAccountConflict(user, { kind: "EMAIL", otherUserId: other, value: target, ip, where });
  }
  try {
    await db
      .update(users)
      .set({ email: target, emailPlaceholder: false, emailVerified: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const other = await otherOwnerOfEmail(target, user.id);
      if (other) throw await recordAccountConflict(user, { kind: "EMAIL", otherUserId: other, value: target, ip, where });
    }
    throw error;
  }
  if (target !== user.email) {
    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.EMAIL_CHANGED,
      entityType: "user",
      entityId: user.id,
      previousValue: { email: hasRealEmail(user) ? maskEmailAddress(user.email) : "placeholder" },
      newValue: { email: maskEmailAddress(target), reason: "dual_auth_add_email" },
      ipAddress: ip,
    });
  }
  return afterFactor({ ...user, email: target }, "EMAIL", ip, where);
}

/** The DualVerify page's view of the account. */
export async function dualVerifyStatus(userId: string): Promise<FactorState & { inForce: boolean }> {
  const user = await loadLiveUser(userId);
  const { dualAuthInForce } = await import("./policy");
  return { ...(await factorState(user)), inForce: await dualAuthInForce() };
}
