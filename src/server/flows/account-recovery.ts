/**
 * Flow spec v3, F18 — recovering an account after losing ONE factor (docs/flows-v3/wave5.md; flag flow_f18; 404
 * while it is off). Losing both is wave 1's support form (src/server/aftercare/account-recovery.ts, flag flow_f17).
 *
 *  1. start:   the person says which one they lost and gives the one still working. "Lost my mobile" → a code to the
 *              account's e-mail (RECOVERY_EMAIL); "lost my e-mail" → a code by SMS to the account's VERIFIED mobile
 *              (RECOVERY_SMS). The reply is the same whether or not an account matches.
 *  2. verify:  the code — and, for an account that owns a shop, the GSTIN or PAN of one of its shops (checked before
 *              the code is used up, so a wrong number keeps the code valid). Answers a short-lived signed recovery
 *              token (rule flowsWave5.recoveryWindowMinutes), bound to the account and to the lost contact's current
 *              value, so it stops working once the change is made.
 *  3. new:     a code to the NEW mobile (SMS, RECOVERY_NEW_SMS) or the NEW e-mail (RECOVERY_NEW_EMAIL).
 *  4. confirm: that code → the new contact is saved as verified, every session of the account ends on its next
 *              request (users.sessions_valid_after), trusted devices are forgotten, and — after the database work —
 *              the old contact is told (old e-mail by e-mail; old mobile by text message where text messages can be
 *              sent) and the account's working contact too.
 *
 * No step reveals whether an account exists before its code is proven; a number or address already used by another
 * account is refused only at step 3, after the person proved they own this account.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, ne } from "drizzle-orm";

import { isValidEmail, maskEmailAddress, normalizeEmail, parseIndianMobile } from "@/lib/contact";
import { getEnv } from "@/lib/env";
import { AppError, conflict, isUniqueViolation, validationFailed } from "@/lib/errors";
import { panBlindIndex } from "@/lib/pan-crypto";
import { maskPhone } from "@/lib/phone";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { endAllSessions } from "@/server/auth-sessions";
import { db } from "@/server/db";
import { shops, users, type User } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { sendText } from "@/server/messaging/sms-whatsapp";
import { getOtpProvider } from "@/server/otp/providers";
import { EMAIL_IN_USE, MOBILE_IN_USE, OTP_INVALID, auditOtp, consumeCode, effectiveOtpRules, issueCode } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable } from "@/server/services/feature-flags";
import { NOTIFICATION_TYPES, notifyEvent } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { flowF18On } from "./wave5-flags";

export type LostFactor = "MOBILE" | "EMAIL";

export const NEEDS_TAX_ID = "Enter the GSTIN or PAN of your shop to confirm it is you.";
const SMS_UNAVAILABLE = "Codes by SMS cannot be sent right now. If you cannot use your e-mail either, use the form for people who lost both.";

async function requireFlag(): Promise<void> {
  if (!(await flowF18On())) throw featureNotAvailable("flow_f18");
}

function parseMobileOrRefuse(value: string): { e164: string; national: string } {
  const parsed = parseIndianMobile(String(value ?? ""));
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { contact: parsed.error } });
  return parsed;
}

function parseEmailOrRefuse(value: string): string {
  const v = String(value ?? "").trim();
  if (!isValidEmail(v)) throw validationFailed("Enter a valid email address, e.g. name@example.com.", { fields: { contact: "Enter a valid email." } });
  return normalizeEmail(v);
}

const isLive = (u: User | undefined): u is User => Boolean(u && u.status === "ACTIVE" && !u.deletedAt);

/** The account the working contact points at: a real e-mail, or a VERIFIED mobile. */
async function accountForWorkingContact(lost: LostFactor, contact: string): Promise<{ user: User | undefined; key: string; phoneE164: string | null }> {
  if (lost === "MOBILE") {
    const email = parseEmailOrRefuse(contact);
    const [user] = await db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
    const ok = isLive(user) && !user.emailPlaceholder && !isPlaceholderEmail(user.email);
    return { user: ok ? user : undefined, key: email, phoneE164: null };
  }
  const { e164 } = parseMobileOrRefuse(contact);
  const [user] = await db.select().from(users).where(and(eq(users.phoneE164, e164), isNull(users.deletedAt)));
  const ok = isLive(user) && Boolean(user.phoneVerifiedAt);
  return { user: ok ? user : undefined, key: ok ? user!.email : `recovery:${e164}`, phoneE164: e164 };
}

function renderRecoveryEmail(code: string, expiryMinutes: number) {
  const text =
    `Your GoKesari account recovery code is ${code}. It expires in ${expiryMinutes} minutes.\n\n` +
    "Someone (we hope you) said they lost the mobile number of this account. If it was not you, ignore this e-mail — nothing changes without this code.\n";
  const html =
    `<p>Your GoKesari <strong>account recovery</strong> code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>It expires in ${expiryMinutes} minutes.</p><p>Someone (we hope you) said they lost the mobile number of this account. If it was not you, ignore this e-mail — nothing changes without this code.</p>`;
  return { subject: "Your GoKesari account recovery code", text, html };
}

function renderNewEmailCode(code: string, expiryMinutes: number) {
  const text = `Your code to add this e-mail to your GoKesari account is ${code}. It expires in ${expiryMinutes} minutes.\n`;
  const html = `<p>Your code to add this e-mail to your GoKesari account is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in ${expiryMinutes} minutes.</p>`;
  return { subject: "Your GoKesari code", text, html };
}

/* ------------------------------------------------------------- step 1 */

export interface RecoveryCodeSent {
  sentTo: string;
  expiryMinutes: number;
  resendAfterSeconds: number;
}

export async function startRecovery(input: { lost: LostFactor; contact: string; ip: string | null }): Promise<RecoveryCodeSent> {
  await requireFlag();
  if (input.lost === "EMAIL" && !(await getOtpProvider("SMS"))) throw new AppError("CONFLICT", SMS_UNAVAILABLE, { reason: "SMS_UNAVAILABLE" });
  const { user, key, phoneE164 } = await accountForWorkingContact(input.lost, input.contact);
  const rules = await effectiveOtpRules(input.lost === "EMAIL" ? "SMS" : "EMAIL");
  const sentTo = input.lost === "MOBILE" ? maskEmailAddress(key) : maskPhone(phoneE164!);
  if (!user) {
    // Same reply as for an account: the form cannot be used to find out who is registered.
    await auditOtp(AUDIT_ACTIONS.OTP_BLOCKED, { email: input.lost === "MOBILE" ? key : "unknown", phoneE164, ip: input.ip, reason: "recovery_no_account" });
    return { sentTo, expiryMinutes: rules.expiryMinutes, resendAfterSeconds: rules.resendCooldownSeconds };
  }
  const sent =
    input.lost === "MOBILE"
      ? await issueCode({ email: user.email, purpose: "RECOVERY_EMAIL", userId: user.id, phoneE164: null, ip: input.ip, render: renderRecoveryEmail })
      : await issueCode({ email: user.email, purpose: "RECOVERY_SMS", userId: user.id, phoneE164, ip: input.ip, bySms: true });
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_STARTED,
    entityType: "user",
    entityId: user.id,
    newValue: { lost: input.lost, sentTo },
    ipAddress: input.ip,
  });
  return { sentTo, ...sent };
}

/* ------------------------------------------------------------- step 2 */

/** The account's shops' GSTINs and PAN blind indexes (null when it owns none). */
async function shopTaxIds(userId: string): Promise<{ gstins: string[]; panHashes: string[] } | null> {
  const rows = await db
    .select({ gstin: shops.gstin, panHash: shops.panHash })
    .from(shops)
    .where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt)));
  if (rows.length === 0) return null;
  return {
    gstins: rows.map((r) => (r.gstin ?? "").toUpperCase()).filter(Boolean),
    panHashes: rows.map((r) => r.panHash ?? "").filter(Boolean),
  };
}

/** Pure-ish: does `given` (a GSTIN or a PAN) match one of the shop's? A PAN also matches a GSTIN that contains it. */
export function taxIdMatches(given: string, ids: { gstins: string[]; panHashes: string[] }, hashPan: (pan: string) => string = panBlindIndex): boolean {
  const v = given.replace(/\s/g, "").toUpperCase();
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return ids.gstins.includes(v);
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) {
    if (ids.gstins.some((g) => g.slice(2, 12) === v)) return true;
    try {
      return ids.panHashes.includes(hashPan(v));
    } catch {
      return false;
    }
  }
  return false;
}

const TOKEN_VERSION = "r1";

function tokenMac(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`account-recovery:${payload}`).digest("hex");
}

/** What the lost factor holds now; the token is void once it changes (single use). */
const lostValueOf = (user: User, lost: LostFactor) => (lost === "MOBILE" ? (user.phoneE164 ?? "") : user.email);

export function createRecoveryToken(user: User, lost: LostFactor, ttlMs: number, now = Date.now()): string {
  const expires = now + ttlMs;
  const bind = createHmac("sha256", getEnv().AUTH_SECRET).update(lostValueOf(user, lost)).digest("hex").slice(0, 16);
  const payload = `${TOKEN_VERSION}.${user.id}.${lost}.${expires}.${bind}`;
  return `${payload}.${tokenMac(payload)}`;
}

async function readRecoveryToken(token: string, now = Date.now()): Promise<{ user: User; lost: LostFactor }> {
  const expired = () => new AppError("FORBIDDEN", "This recovery has expired. Please start again.", { reason: "RECOVERY_EXPIRED" });
  const parts = String(token ?? "").split(".");
  if (parts.length !== 6 || parts[0] !== TOKEN_VERSION) throw expired();
  const [, userId, lost, expires, bind, mac] = parts;
  const payload = parts.slice(0, 5).join(".");
  const expected = Buffer.from(tokenMac(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw expired();
  if (!(Number(expires) > now) || (lost !== "MOBILE" && lost !== "EMAIL")) throw expired();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!isLive(user)) throw expired();
  const current = createHmac("sha256", getEnv().AUTH_SECRET).update(lostValueOf(user, lost)).digest("hex").slice(0, 16);
  if (current !== bind) throw expired();
  return { user, lost };
}

export interface RecoveryVerified {
  token: string;
  lost: LostFactor;
  expiresInMinutes: number;
}

export async function verifyRecovery(input: { lost: LostFactor; contact: string; code: string; taxId?: string | null; ip: string | null }): Promise<RecoveryVerified> {
  await requireFlag();
  const { user, phoneE164 } = await accountForWorkingContact(input.lost, input.contact);
  if (!user) {
    await auditOtp(AUDIT_ACTIONS.OTP_FAILED, { email: "unknown", phoneE164, ip: input.ip, reason: "recovery_no_account" });
    throw validationFailed(OTP_INVALID);
  }
  const taxIds = await shopTaxIds(user.id);
  await consumeCode({
    email: user.email,
    purpose: input.lost === "MOBILE" ? "RECOVERY_EMAIL" : "RECOVERY_SMS",
    code: String(input.code ?? ""),
    ip: input.ip,
    userId: user.id,
    ...(input.lost === "EMAIL" ? { phoneE164 } : {}),
    // The shop check runs once the code is known to be right and before it is used up.
    beforeConsume: async () => {
      if (!taxIds) return;
      const given = String(input.taxId ?? "").trim();
      if (!given) throw validationFailed(NEEDS_TAX_ID, { needsTaxId: true, fields: { taxId: NEEDS_TAX_ID } });
      if (!taxIdMatches(given, taxIds)) {
        throw validationFailed("That GSTIN or PAN does not match your shop.", { needsTaxId: true, fields: { taxId: "Does not match your shop." } });
      }
    },
  });
  const { recoveryWindowMinutes } = await getRule("flowsWave5");
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_VERIFIED,
    entityType: "user",
    entityId: user.id,
    newValue: { lost: input.lost, shopCheck: Boolean(taxIds) },
    ipAddress: input.ip,
  });
  return { token: createRecoveryToken(user, input.lost, recoveryWindowMinutes * 60_000), lost: input.lost, expiresInMinutes: recoveryWindowMinutes };
}

/* ------------------------------------------------------------- step 3 */

async function assertNewMobileFree(e164: string, userId: string): Promise<void> {
  const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.phoneE164, e164), isNull(users.deletedAt), ne(users.id, userId)));
  if (taken) throw conflict(MOBILE_IN_USE, { fields: { value: MOBILE_IN_USE } });
}

async function assertNewEmailFree(email: string, userId: string): Promise<void> {
  const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, userId)));
  if (taken) throw conflict(EMAIL_IN_USE, { fields: { value: EMAIL_IN_USE } });
}

export async function sendNewContactCode(input: { token: string; value: string; ip: string | null }): Promise<RecoveryCodeSent> {
  await requireFlag();
  const { user, lost } = await readRecoveryToken(input.token);
  if (lost === "MOBILE") {
    const { e164 } = parseMobileOrRefuse(input.value);
    if (!(await getOtpProvider("SMS"))) throw new AppError("CONFLICT", SMS_UNAVAILABLE, { reason: "SMS_UNAVAILABLE" });
    await assertNewMobileFree(e164, user.id);
    const sent = await issueCode({ email: user.email, purpose: "RECOVERY_NEW_SMS", userId: user.id, phoneE164: e164, ip: input.ip, bySms: true });
    return { sentTo: maskPhone(e164), ...sent };
  }
  const email = parseEmailOrRefuse(input.value);
  if (email === user.email) throw validationFailed("That is the e-mail you said you lost. Enter a new one.", { fields: { value: "Enter a new e-mail." } });
  await assertNewEmailFree(email, user.id);
  const sent = await issueCode({ email, purpose: "RECOVERY_NEW_EMAIL", userId: user.id, phoneE164: null, ip: input.ip, render: renderNewEmailCode });
  return { sentTo: maskEmailAddress(email), ...sent };
}

/* ------------------------------------------------------------- step 4 */

export interface RecoveryDone {
  replaced: LostFactor;
  /** The new contact, masked. */
  now: string;
  signedOutEverywhere: true;
}

export async function confirmNewContact(input: { token: string; value: string; code: string; ip: string | null }): Promise<RecoveryDone> {
  await requireFlag();
  const { user, lost } = await readRecoveryToken(input.token);
  const now = new Date();
  let masked: string;
  if (lost === "MOBILE") {
    const { e164, national } = parseMobileOrRefuse(input.value);
    await consumeCode({ email: user.email, purpose: "RECOVERY_NEW_SMS", code: String(input.code ?? ""), ip: input.ip, phoneE164: e164, userId: user.id });
    await assertNewMobileFree(e164, user.id);
    try {
      await db.update(users).set({ phoneE164: e164, phone: national, phoneVerifiedAt: now, updatedAt: now }).where(eq(users.id, user.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(MOBILE_IN_USE);
      throw error;
    }
    masked = maskPhone(e164);
    await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.PHONE_LINKED, entityType: "user", entityId: user.id, newValue: { phone: masked, reason: "account_recovery" }, ipAddress: input.ip });
  } else {
    const email = parseEmailOrRefuse(input.value);
    await consumeCode({ email, purpose: "RECOVERY_NEW_EMAIL", code: String(input.code ?? ""), ip: input.ip, userId: user.id });
    await assertNewEmailFree(email, user.id);
    try {
      await db.update(users).set({ email, emailVerified: now, emailPlaceholder: false, updatedAt: now }).where(eq(users.id, user.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(EMAIL_IN_USE);
      throw error;
    }
    masked = maskEmailAddress(email);
    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.EMAIL_CHANGED,
      entityType: "user",
      entityId: user.id,
      previousValue: { email: maskEmailAddress(user.email) },
      newValue: { email: masked, reason: "account_recovery" },
      ipAddress: input.ip,
    });
  }

  // Signed out on every device, every trusted device forgotten.
  await endAllSessions(user.id, "account_recovery", now);
  const { revokeTrustedDevices } = await import("@/server/dual-auth/devices");
  const { syncNeedsSecondFactor } = await import("@/server/dual-auth/policy");
  await revokeTrustedDevices(user.id, "account_recovery").catch((e) => console.error("[recovery] revoke devices", e));
  await syncNeedsSecondFactor(user.id).catch(() => null);
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_COMPLETED,
    entityType: "user",
    entityId: user.id,
    newValue: { replaced: lost, now: masked },
    ipAddress: input.ip,
  });

  // After the database work: tell the old contact (and the account).
  await alertOldContact(user, lost, masked);
  return { replaced: lost, now: masked, signedOutEverywhere: true };
}

async function alertOldContact(before: User, lost: LostFactor, masked: string): Promise<void> {
  const line =
    lost === "MOBILE"
      ? `The mobile number of your GoKesari account was replaced (now ${masked}) through account recovery, and the account was signed out on every device.`
      : `The e-mail of your GoKesari account was replaced (now ${masked}) through account recovery, and the account was signed out on every device.`;
  const tail = " If this was not you, contact GoKesari support immediately.";
  if (lost === "MOBILE") {
    if (before.phoneE164) {
      await sendText("SMS", before.phoneE164, `GoKesari: ${line}${tail}`.slice(0, 480), "account_recovery_alert").catch((e) =>
        console.error("[recovery] old-mobile text not sent", e instanceof Error ? e.message : e),
      );
    }
    if (!before.emailPlaceholder && !isPlaceholderEmail(before.email)) {
      await sendEmail({ to: before.email, subject: "Your GoKesari mobile number was replaced", text: `${line}${tail}\n`, html: `<p>${line}</p><p>${tail.trim()}</p>` }).catch((e) =>
        console.error("[recovery] e-mail notice failed", e),
      );
    }
    await notifyEvent(NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED, before.id, { action: "replaced through account recovery" }).catch(() => null);
  } else if (!before.emailPlaceholder && !isPlaceholderEmail(before.email)) {
    await sendEmail({ to: before.email, subject: "Your GoKesari e-mail address was replaced", text: `${line}${tail}\n`, html: `<p>${line}</p><p>${tail.trim()}</p>` }).catch((e) =>
      console.error("[recovery] old-email notice failed", e),
    );
  }
}
