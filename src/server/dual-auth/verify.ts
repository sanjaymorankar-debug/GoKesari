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
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull, ne } from "drizzle-orm";

import { isValidEmail, maskEmailAddress, normalizeEmail, parseIndianMobile } from "@/lib/contact";
import { AppError, conflict, forbidden, isUniqueViolation, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { loginOtps, users, type User } from "@/server/db/schema";
import { getEnv } from "@/lib/env";
import { sendEmail } from "@/server/email/transport";
import { getOtpProvider } from "@/server/otp/providers";
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

async function afterFactor(user: User, factor: "MOBILE" | "EMAIL", ip: string | null, where: string, trustDevice = true): Promise<FactorState> {
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
    if (trustDevice) await trustThisDevice(user.id, `both factors (${where})`).catch((e) => console.error("[dual-auth] trust device", e));
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
  return applyVerifiedEmail(user, target, ip, where);
}

/** The address was just proven (code or link): duplicate check, save it as the verified e-mail, then the factor. */
async function applyVerifiedEmail(user: User, target: string, ip: string | null, where: string, trustDevice = true): Promise<FactorState> {
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
  return afterFactor({ ...user, email: target }, "EMAIL", ip, where, trustDevice);
}

/* ------------------------------------------------------- e-mail by link */

/**
 * Login & auth item 4 (owner 27-Nov-2026): "E-mail me a link instead" also for an account registered with a mobile
 * number alone, adding a NEW address. The link (single use, 15 minutes) is bound to this account and that address;
 * opening it and pressing Confirm saves the address as the account's verified e-mail — with the same duplicate check
 * as the code (DIFFERENT_ACCOUNTS, logged for admin review). Rows live in login_otps (purpose
 * DUAL_VERIFY_EMAIL_LINK; only an HMAC of the token is stored).
 */
export const EMAIL_LINK_PURPOSE = "DUAL_VERIFY_EMAIL_LINK" as const;
const EMAIL_LINK_MINUTES = 15;
const EMAIL_LINK_COOLDOWN_S = 30;
const EMAIL_LINK_MAX_PER_15_MIN = 4;
export const EMAIL_LINK_INVALID = "This link is not valid any more. Open the newest link we sent, or ask for a new one on the Verify page.";

function linkHash(id: string, token: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`dual-email-link:${id}:${token}`).digest("hex");
}

function siteBase(): string {
  return (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

export async function sendEmailFactorLink(userId: string, email: string | null | undefined, ip: string | null, returnTo = "/"): Promise<{ sentTo: string }> {
  const user = await loadLiveUser(userId);
  if ((await factorState(user)).emailVerified) throw conflict("Your e-mail is already verified.");
  const target = hasRealEmail(user) ? user.email : parseEmailOrRefuse(email);
  const recent = await db
    .select({ createdAt: loginOtps.createdAt })
    .from(loginOtps)
    .where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, EMAIL_LINK_PURPOSE), gt(loginOtps.createdAt, new Date(Date.now() - 15 * 60_000))));
  const last = Math.max(0, ...recent.map((r) => r.createdAt.getTime()));
  if (Date.now() - last < EMAIL_LINK_COOLDOWN_S * 1000) {
    throw new AppError("RATE_LIMITED", `Please wait ${Math.ceil((EMAIL_LINK_COOLDOWN_S * 1000 - (Date.now() - last)) / 1000)} seconds before asking for another link.`);
  }
  if (recent.length >= EMAIL_LINK_MAX_PER_15_MIN) throw new AppError("RATE_LIMITED", "Too many links were asked for. Try again in 15 minutes.");
  // Only the newest link works.
  await db
    .update(loginOtps)
    .set({ supersededAt: new Date() })
    .where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, EMAIL_LINK_PURPOSE), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt)));
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await db.insert(loginOtps).values({
    id,
    userId: user.id,
    email: target,
    phoneE164: null,
    purpose: EMAIL_LINK_PURPOSE,
    channel: "EMAIL",
    codeHash: linkHash(id, token),
    expiresAt: new Date(Date.now() + EMAIL_LINK_MINUTES * 60_000),
    maxAttempts: 1,
    ipAddress: ip,
  });
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  const url = `${siteBase()}/account/verify/email?t=${id}.${token}&return=${encodeURIComponent(safeReturn)}`;
  await sendEmail({
    to: target,
    subject: "Verify your e-mail for GoKesari",
    text: `Open this link to verify ${target} for your GoKesari account:\n\n${url}\n\nIt works once and expires in ${EMAIL_LINK_MINUTES} minutes. If you did not ask for it, ignore this e-mail.\n`,
    html: `<p>Open this link to verify <strong>${target}</strong> for your GoKesari account:</p><p><a href="${url}">Verify my e-mail</a></p><p>It works once and expires in ${EMAIL_LINK_MINUTES} minutes. If you did not ask for it, ignore this e-mail.</p>`,
  });
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.DUAL_AUTH_FACTOR_VERIFIED, entityType: "user", entityId: user.id, newValue: { factor: "EMAIL", step: "link_sent", to: maskEmailAddress(target) }, ipAddress: ip });
  return { sentTo: maskEmailAddress(target) };
}

/** What the link page shows before Confirm (null = not valid). */
export async function readEmailFactorLink(t: string): Promise<{ maskedEmail: string } | null> {
  const row = await linkRow(t);
  return row ? { maskedEmail: maskEmailAddress(row.email ?? "") } : null;
}

async function linkRow(t: string) {
  const [id, token] = String(t ?? "").split(".");
  if (!id || !token || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(loginOtps).where(and(eq(loginOtps.id, id), eq(loginOtps.purpose, EMAIL_LINK_PURPOSE)));
  if (!row || !row.userId || !row.email || row.consumedAt || row.supersededAt || row.expiresAt.getTime() <= Date.now()) return null;
  const expected = Buffer.from(row.codeHash);
  const given = Buffer.from(linkHash(id, token));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return row;
}

/**
 * Confirm on the link page. `sessionUserId`: who is signed in on this browser — the device is trusted only when it
 * is the same account (a link opened elsewhere verifies the address but trusts nothing).
 */
export async function confirmEmailFactorLink(t: string, ip: string | null, sessionUserId: string | null): Promise<FactorState> {
  const row = await linkRow(t);
  if (!row) throw validationFailed(EMAIL_LINK_INVALID);
  const [used] = await db
    .update(loginOtps)
    .set({ consumedAt: new Date(), attempts: 1 })
    .where(and(eq(loginOtps.id, row.id), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt)))
    .returning({ id: loginOtps.id });
  if (!used) throw validationFailed(EMAIL_LINK_INVALID);
  const user = await loadLiveUser(row.userId!);
  if ((await factorState(user)).emailVerified) return factorState(user);
  // The account's own address, or (mobile-only account) the address the link was sent to.
  const target = hasRealEmail(user) ? user.email : row.email!;
  await auditOtp(AUDIT_ACTIONS.OTP_VERIFIED, { email: target, actorId: user.id, ip, otpId: row.id, purpose: EMAIL_LINK_PURPOSE });
  return applyVerifiedEmail(user, target, ip, "verify_email_link", sessionUserId === user.id);
}

/** The DualVerify page's view of the account. */
export async function dualVerifyStatus(userId: string): Promise<FactorState & { inForce: boolean; canVerify: boolean }> {
  const user = await loadLiveUser(userId);
  const { dualAuthInForce } = await import("./policy");
  // Owner 27-Nov-2026: an account may verify its mobile by SMS whenever SMS codes can be sent on this site, also
  // with the dual_auth flag off (the flag only decides whether both factors are *required*).
  const canVerify = (await getOtpProvider("SMS")) !== null;
  return { ...(await factorState(user)), inForce: await dualAuthInForce(), canVerify };
}
