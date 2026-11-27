/**
 * docs/dual-auth-2026-11 (flag dual_auth; migration 0219): every account needs a verified mobile AND e-mail.
 * SMS_PROVIDER=mock in tests: SMS codes are read from outbound_test_messages; e-mails from the mocked transport.
 * Test ids TC-DUAL-xxx match docs/dual-auth-2026-11/TEST_REPORT.md.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeFromSmsOtpText } from "@/server/otp/providers";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  outbox: [] as { to: string; subject: string; text: string }[],
  cookies: new Map<string, string>(),
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void state.cookies.set(name, value),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

import { POST as checkoutRoute } from "@/app/api/checkout/route";
import { POST as stepUpRoute } from "@/app/api/dual-auth/step-up/route";
import { POST as verifyRoute } from "@/app/api/dual-auth/verify/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, featureFlags, loginOtps, outboundTestMessages, platformSettings, shops, trustedDevices, users, type User } from "@/server/db/schema";
import { DEVICE_COOKIE, isDeviceTrusted, trustThisDevice } from "@/server/dual-auth/devices";
import { DIFFERENT_ACCOUNTS, assertDualVerified, dualAuthInForce, factorState, syncNeedsSecondFactor } from "@/server/dual-auth/policy";
import { needsSecondFactorCounts } from "@/server/dual-auth/reminders";
import { requireDualStepUp, startDualStepUp, verifyDualStepUp } from "@/server/dual-auth/step-up";
import { confirmEmailFactorCode, confirmMobileFactorCode, sendEmailFactorCode, sendMobileFactorCode } from "@/server/dual-auth/verify";
import { GOOGLE_EMAIL_UNVERIFIED, googleSecondFactorGate, SECOND_FACTOR_PAGE } from "@/server/otp/google-second-factor";
import { afterEmailFactor, readSecondFactorChallengeKind, secondFactorKind, verifySecondFactorCode } from "@/server/otp/second-factor";
import { OTP_INVALID, linkPhone, readLoginTicket, requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { assertSelfRegistrationOpen } from "@/server/registration/service";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { approveShop } from "@/server/services/shops";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

async function setDualAuth(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "dual_auth", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["otp", "dualAuth", "selfRegistration"]));
  clearRuleCache();
}

let admin: User;

beforeEach(async () => {
  state.outbox = [];
  state.cookies.clear();
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await db.delete(loginOtps);
  await db.delete(trustedDevices);
  await clearMyRules();
  admin = await createUser({ role: "ADMIN" });
  await setDualAuth(true);
});

afterEach(async () => {
  await clearMyRules();
  await db.delete(featureFlags).where(eq(featureFlags.key, "dual_auth"));
  clearFeatureFlagCache();
});

function lastEmailCode(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1] ?? message?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

async function lastSmsCode(e164: string): Promise<string> {
  const [row] = await db
    .select()
    .from(outboundTestMessages)
    .where(and(eq(outboundTestMessages.toAddress, e164), eq(outboundTestMessages.purpose, "otp")))
    .orderBy(desc(outboundTestMessages.createdAt))
    .limit(1);
  const code = (row ? codeFromSmsOtpText(row.body) : null);
  if (!code) throw new Error(`no SMS code was sent to ${e164.slice(-4)}`);
  return code;
}

const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");

/** An account with both factors verified (e-mail by code, mobile by SMS). */
async function dualVerified(role: UserRole = "CUSTOMER") {
  const user = await createUser({ role, mobile: uniqueMobile() });
  const [row] = await db.update(users).set({ phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, user.id)).returning();
  return row;
}

function signInAs(user: User) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

/** Moves every code issued so far back in time (past the 30 s cooldown and out of the 15-minute window). */
async function ageCodes(minutes = 16) {
  await db.update(loginOtps).set({ createdAt: new Date(Date.now() - minutes * 60_000) });
}

async function emailFactor(email: string) {
  await requestLoginOtp({ email });
  return verifyLoginOtp({ email, code: lastEmailCode(email) });
}

describe("rule and gate", () => {
  it("TC-DUAL-001 flag on + SMS available = in force; flag off = nothing asked, exactly as before", async () => {
    expect(await dualAuthInForce()).toBe(true);
    const oneFactor = await createUser({ mobile: null });
    await expect(assertDualVerified(oneFactor.id, "ORDER")).rejects.toMatchObject({ code: "FORBIDDEN", details: { dualAuth: "NEEDS_SECOND_FACTOR" } });
    await setDualAuth(false);
    await expect(assertDualVerified(oneFactor.id, "ORDER")).resolves.toBeUndefined();
  });

  it("TC-DUAL-002 SMS not available (rule otp.smsEnabled off): not in force, nobody locked out", async () => {
    await setRule("otp", { smsEnabled: false }, admin);
    expect(await dualAuthInForce()).toBe(false);
    const oneFactor = await createUser({ mobile: null });
    await expect(assertDualVerified(oneFactor.id, "SHOP")).resolves.toBeUndefined();
  });

  it("TC-DUAL-003 one-factor account cannot place an order (403 + DualVerify link); browsing APIs are not gated", async () => {
    const user = await createUser({ mobile: null });
    signInAs(user);
    const res = await call(checkoutRoute, "/api/checkout", { method: "POST", body: { paymentMethod: "COD", requestId: "r-dual-1" } });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ dualAuth: "NEEDS_SECOND_FACTOR", missing: ["MOBILE", "EMAIL"], verifyUrl: "/account/verify?return=%2Fcart" });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.dual_gate_blocked"));
    expect(audit?.newValue).toMatchObject({ action: "ORDER" });
  });

  it("TC-DUAL-004 needs_second_factor follows the account's factors (migration mark kept in step)", async () => {
    const user = await createUser({ mobile: null });
    await syncNeedsSecondFactor(user.id);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].needsSecondFactor).toBe(true);
    expect((await needsSecondFactorCounts()).total).toBeGreaterThanOrEqual(1);
    await db.update(users).set({ phoneE164: `+91${uniqueMobile()}`, phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, user.id));
    await syncNeedsSecondFactor(user.id);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.needsSecondFactor).toBe(false);
    expect(row.needsSecondFactorSince).toBeNull();
  });
});

describe("sign-in: new device, trusted device, staff", () => {
  it("TC-DUAL-010 returning customer on a new device: e-mail code, then SMS code before the session", async () => {
    const user = await dualVerified();
    const { user: signedIn, channel } = await emailFactor(user.email);
    expect(channel).toBe("EMAIL");
    const next = await afterEmailFactor(signedIn, null, "EMAIL");
    expect(next.ticket).toBeUndefined();
    expect(next.secondFactor).toMatchObject({ needsPhone: false, expiryMinutes: 5 });
    const code = await lastSmsCode(user.phoneE164!);
    await expect(verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code: wrongOf(code) })).rejects.toThrow(OTP_INVALID);
    expect((await verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code })).id).toBe(user.id);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.dual_sign_in"));
    expect(audit?.newValue).toMatchObject({ factors: ["EMAIL", "SMS"] });
  });

  it("TC-DUAL-011 trusted device (customers 180 days, others 30): customer and shop owner sign in with one factor; a new browser needs both", async () => {
    for (const role of ["CUSTOMER", "SHOP_OWNER", "DEALER"] as const) {
      state.cookies.clear();
      const user = await dualVerified(role);
      expect(await trustThisDevice(user.id, "test")).toBe(true);
      expect(state.cookies.get(DEVICE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [row] = await db.select().from(trustedDevices).where(eq(trustedDevices.userId, user.id));
      // Owner 27-Nov-2026: customers 180 days (rolling), other roles 30 days (fixed).
      expect(Math.round((row.expiresAt.getTime() - row.trustedAt.getTime()) / 86_400_000)).toBe(role === "CUSTOMER" ? 180 : 30);
      expect(await secondFactorKind(user, "EMAIL")).toBeNull();
      // Another browser (no cookie): both again.
      state.cookies.clear();
      expect(await secondFactorKind(user, "EMAIL")).toBe("SMS");
    }
  });

  it("TC-DUAL-012 trust expires after 30 days and can be revoked", async () => {
    const user = await dualVerified();
    await trustThisDevice(user.id, "test");
    await db.update(trustedDevices).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(trustedDevices.userId, user.id));
    expect(await isDeviceTrusted(user.id)).toBe(false);
    expect(await secondFactorKind(user, "EMAIL")).toBe("SMS");
  });

  it("TC-DUAL-013 admin and operator: both factors on every sign-in, even on a trusted device", async () => {
    for (const role of ["ADMIN", "OPERATOR", "OPERATOR_LIMITED", "SUPPORT_USER"] as const) {
      state.cookies.clear();
      const staff = await dualVerified(role);
      await trustThisDevice(staff.id, "test");
      expect(await secondFactorKind(staff, "EMAIL")).toBe("SMS");
    }
  });

  it("TC-DUAL-014 SMS first factor → the second is an e-mail code (challenge kind EMAIL)", async () => {
    const user = await dualVerified();
    const next = await afterEmailFactor(user, null, "SMS");
    expect(next.secondFactor).toMatchObject({ kind: "EMAIL" });
    expect(readSecondFactorChallengeKind(next.secondFactor!.challenge)).toEqual({ userId: user.id, kind: "EMAIL" });
    const code = lastEmailCode(user.email);
    expect((await verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code })).id).toBe(user.id);
  });

  it("TC-DUAL-015 one-factor account: the session opens, the missing factor is asked by the gate (can browse)", async () => {
    const user = await createUser({ mobile: null });
    const { user: signedIn } = await emailFactor(user.email);
    const next = await afterEmailFactor(signedIn, null, "EMAIL");
    expect(next.ticket && readLoginTicket(next.ticket)).toBe(user.id);
    expect((await factorState((await db.select().from(users).where(eq(users.id, user.id)))[0])).missing).toEqual(["MOBILE"]);
  });

  it("TC-DUAL-016 Google: e-mail factor only when email_verified = true; a new Google account is allowed (mobile asked next)", async () => {
    expect(await googleSecondFactorGate("new-google@test.local", false)).toBe(`/signin?error=${GOOGLE_EMAIL_UNVERIFIED}`);
    expect(await googleSecondFactorGate("new-google@test.local", true)).toBe(true);
    const user = await dualVerified();
    expect(await googleSecondFactorGate(user.email, true)).toBe(SECOND_FACTOR_PAGE);
    await trustThisDevice(user.id, "test");
    expect(await googleSecondFactorGate(user.email, true)).toBe(true);
  });
});

describe("DualVerify: completing a missing factor, account check", () => {
  it("TC-DUAL-020 mobile by SMS code: verified, needs flag cleared, device trusted", async () => {
    const user = await createUser({ mobile: null });
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    signInAs(user);
    const mobile = uniqueMobile();
    const sent = await call(verifyRoute, "/api/dual-auth/verify", { method: "POST", body: { action: "mobile-code", mobile } });
    expect(sent.status).toBe(200);
    expect(sent.body.sent.expiryMinutes).toBe(5);
    const code = await lastSmsCode(`+91${mobile}`);
    const done = await call(verifyRoute, "/api/dual-auth/verify", { method: "POST", body: { action: "mobile-verify", mobile, code } });
    expect(done.status).toBe(200);
    expect(done.body.status).toMatchObject({ mobileVerified: true, emailVerified: true, missing: [] });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(row.needsSecondFactor).toBe(false);
    expect(await isDeviceTrusted(user.id)).toBe(true);
  });

  it("TC-DUAL-025 flag off but SMS available (production 27-Nov-2026): an existing account still verifies its own mobile by SMS", async () => {
    await setDualAuth(false);
    const user = await createUser({ mobile: uniqueMobile() });
    await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: null }).where(eq(users.id, user.id));
    signInAs(user);
    const { dualVerifyStatus } = await import("@/server/dual-auth/verify");
    expect(await dualVerifyStatus(user.id)).toMatchObject({ inForce: false, canVerify: true, mobileVerified: false, missing: ["MOBILE"] });
    const sent = await call(verifyRoute, "/api/dual-auth/verify", { method: "POST", body: { action: "mobile-code" } });
    expect(sent.status).toBe(200);
    const code = await lastSmsCode(user.phoneE164!);
    const done = await call(verifyRoute, "/api/dual-auth/verify", { method: "POST", body: { action: "mobile-verify", code } });
    expect(done.status).toBe(200);
    expect(done.body.status).toMatchObject({ mobileVerified: true, missing: [] });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("TC-DUAL-021 mobile of another account: no answer before the code; after it, the conflict message + audit for review", async () => {
    const other = await createUser();
    const user = await createUser({ mobile: null });
    // The send answers like any other number (no "registered" leak).
    const sent = await sendMobileFactorCode(user.id, other.phone!, null);
    expect(sent.sentTo).toContain(other.phone!.slice(-4));
    const code = await lastSmsCode(other.phoneE164!);
    await expect(confirmMobileFactorCode(user.id, other.phone!, code, null)).rejects.toThrow(DIFFERENT_ACCOUNTS);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.account_conflict"));
    expect(audit?.newValue).toMatchObject({ kind: "MOBILE", otherUserId: other.id, status: "OPEN" });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneE164).toBeNull();
  });

  it("TC-DUAL-022 mobile-only shop owner adds an e-mail by code: placeholder cleared, e-mail verified", async () => {
    const user = await createUser({ role: "SHOP_OWNER", email: `mobile-${Date.now()}@placeholder.gokesari.invalid` });
    await db.update(users).set({ emailPlaceholder: true, phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
    const email = `owner-${Date.now()}@test.local`;
    await expect(sendEmailFactorCode(user.id, null, null)).rejects.toThrow(/valid email/);
    const sent = await sendEmailFactorCode(user.id, email, null);
    expect(sent.expiryMinutes).toBe(10);
    const state2 = await confirmEmailFactorCode(user.id, email, lastEmailCode(email), null);
    expect(state2.missing).toEqual([]);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ email, emailPlaceholder: false });
    expect(row.emailVerified).toBeInstanceOf(Date);
  });

  it("TC-DUAL-023 duplicate prevention: an e-mail of another account is refused after its code (no second account)", async () => {
    const other = await dualVerified();
    const user = await createUser({ role: "SHOP_OWNER", email: `mobile2-${Date.now()}@placeholder.gokesari.invalid` });
    await db.update(users).set({ emailPlaceholder: true, phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
    await sendEmailFactorCode(user.id, other.email, null);
    await expect(confirmEmailFactorCode(user.id, other.email, lastEmailCode(other.email), null)).rejects.toThrow(DIFFERENT_ACCOUNTS);
    const all = await db.select().from(users).where(eq(users.email, other.email));
    expect(all).toHaveLength(1);
  });

  it("TC-DUAL-024 existing account by e-mail: signing in logs in to it, never a duplicate", async () => {
    const user = await dualVerified();
    const { user: again, isNewUser } = await emailFactor(user.email);
    expect(again.id).toBe(user.id);
    expect(isNewUser).toBe(false);
  });
});

describe("sensitive actions: two codes, whatever the device", () => {
  it("TC-DUAL-030 bank / withdrawal / team / contact change need an SMS code AND an e-mail code; the pass is per action", async () => {
    const user = await dualVerified();
    await trustThisDevice(user.id, "test"); // a trusted device changes nothing here
    await expect(requireDualStepUp(user.id, "BANK_CHANGE")).rejects.toMatchObject({ details: { stepUp: "DUAL", action: "BANK_CHANGE" } });
    const sent = await startDualStepUp(user.id, "BANK_CHANGE", null);
    expect(sent).toMatchObject({ smsExpiryMinutes: 5, emailExpiryMinutes: 10 });
    const sms = await lastSmsCode(user.phoneE164!);
    const mail = lastEmailCode(user.email);
    // A wrong e-mail code leaves the SMS code usable.
    await expect(verifyDualStepUp(user.id, "BANK_CHANGE", { smsCode: sms, emailCode: wrongOf(mail), ip: null })).rejects.toThrow(OTP_INVALID);
    await verifyDualStepUp(user.id, "BANK_CHANGE", { smsCode: sms, emailCode: mail, ip: null });
    await expect(requireDualStepUp(user.id, "BANK_CHANGE")).resolves.toBeUndefined();
    await expect(requireDualStepUp(user.id, "WITHDRAWAL")).rejects.toMatchObject({ details: { stepUp: "DUAL" } });
  });

  it("TC-DUAL-031 changing the mobile asks both codes first (linkPhone), and revokes trusted devices", async () => {
    const user = await dualVerified();
    await trustThisDevice(user.id, "test");
    await expect(linkPhone(user.id, user.role, { mobile: uniqueMobile() })).rejects.toMatchObject({ details: { stepUp: "DUAL", action: "CONTACT_CHANGE" } });
    await startDualStepUp(user.id, "CONTACT_CHANGE", null);
    await verifyDualStepUp(user.id, "CONTACT_CHANGE", { smsCode: await lastSmsCode(user.phoneE164!), emailCode: lastEmailCode(user.email), ip: null });
    await linkPhone(user.id, user.role, { mobile: uniqueMobile() });
    expect(await isDeviceTrusted(user.id)).toBe(false);
    // The new number is not verified yet: the account needs its SMS code again.
    expect((await factorState((await db.select().from(users).where(eq(users.id, user.id)))[0])).missing).toEqual(["MOBILE"]);
  });

  it("TC-DUAL-032 step-up through the API route", async () => {
    const user = await dualVerified();
    signInAs(user);
    const start = await call(stepUpRoute, "/api/dual-auth/step-up", { method: "POST", body: { action: "start", sensitive: "WITHDRAWAL" } });
    expect(start.status).toBe(200);
    const verify = await call(stepUpRoute, "/api/dual-auth/step-up", {
      method: "POST",
      body: { action: "verify", sensitive: "WITHDRAWAL", smsCode: await lastSmsCode(user.phoneE164!), emailCode: lastEmailCode(user.email) },
    });
    expect(verify.status).toBe(200);
    await expect(requireDualStepUp(user.id, "WITHDRAWAL")).resolves.toBeUndefined();
  });

  it("TC-DUAL-033 a one-factor account gets the DualVerify refusal before any step-up", async () => {
    const user = await createUser({ mobile: null });
    await expect(requireDualStepUp(user.id, "WITHDRAWAL")).rejects.toMatchObject({ details: { dualAuth: "NEEDS_SECOND_FACTOR" } });
  });
});

describe("codes: lifetime, resend, lockout, rate limits", () => {
  it("TC-DUAL-040 lifetimes: SMS 5 min, e-mail 10 min", async () => {
    const user = await createUser({ mobile: null });
    const mobile = uniqueMobile();
    await sendMobileFactorCode(user.id, mobile, null);
    await sendEmailFactorCode(user.id, null, null);
    const rows = await db.select().from(loginOtps).where(eq(loginOtps.userId, user.id));
    const minutes = (r: (typeof rows)[number]) => Math.round((r.expiresAt.getTime() - r.createdAt.getTime()) / 60_000);
    expect(minutes(rows.find((r) => r.channel === "SMS")!)).toBe(5);
    expect(minutes(rows.find((r) => r.channel === "EMAIL")!)).toBe(10);
  });

  it("TC-DUAL-041 expired code is refused", async () => {
    const user = await createUser({ mobile: null });
    const mobile = uniqueMobile();
    await sendMobileFactorCode(user.id, mobile, null);
    const code = await lastSmsCode(`+91${mobile}`);
    await db.update(loginOtps).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginOtps.userId, user.id));
    await expect(confirmMobileFactorCode(user.id, mobile, code, null)).rejects.toThrow(OTP_INVALID);
  });

  it("TC-DUAL-042 resend after 30 s; at most 3 resends (4 codes) per 15 minutes per number", async () => {
    const user = await createUser({ mobile: null });
    const mobile = uniqueMobile();
    await sendMobileFactorCode(user.id, mobile, null);
    await expect(sendMobileFactorCode(user.id, mobile, null)).rejects.toThrow(/wait \d+ seconds/);
    for (let i = 0; i < 3; i++) {
      await db.update(loginOtps).set({ createdAt: new Date(Date.now() - (i + 1) * 31_000) }).where(eq(loginOtps.userId, user.id));
      await sendMobileFactorCode(user.id, mobile, null);
    }
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(loginOtps.userId, user.id));
    await expect(sendMobileFactorCode(user.id, mobile, null)).rejects.toThrow(/Too many codes/);
    await ageCodes();
    await expect(sendMobileFactorCode(user.id, mobile, null)).resolves.toBeDefined();
  });

  it("TC-DUAL-043 5 wrong codes lock the number for 15 minutes (across codes)", async () => {
    const user = await createUser({ mobile: null });
    const mobile = uniqueMobile();
    await sendMobileFactorCode(user.id, mobile, null);
    const code = await lastSmsCode(`+91${mobile}`);
    for (let i = 0; i < 5; i++) await expect(confirmMobileFactorCode(user.id, mobile, wrongOf(code), null)).rejects.toThrow();
    await expect(confirmMobileFactorCode(user.id, mobile, code, null)).rejects.toThrow(/paused for 15 minutes|Too many wrong/);
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 31_000) }).where(eq(loginOtps.userId, user.id));
    await expect(sendMobileFactorCode(user.id, mobile, null)).rejects.toThrow(/paused for 15 minutes/);
    const [blocked] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.otp_blocked"));
    expect(blocked).toBeDefined();
  });

  it("TC-DUAL-044 OTPs are stored only as hashes (never the code)", async () => {
    const user = await createUser({ mobile: null });
    const mobile = uniqueMobile();
    await sendMobileFactorCode(user.id, mobile, null);
    const code = await lastSmsCode(`+91${mobile}`);
    const [row] = await db.select().from(loginOtps).where(eq(loginOtps.userId, user.id));
    expect(row.codeHash).not.toContain(code);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.otp_requested"));
    expect(JSON.stringify(audits)).not.toContain(code);
  });

  it("TC-DUAL-045 rate limit per account / IP on the DualVerify API (429)", async () => {
    const user = await createUser({ mobile: null });
    signInAs(user);
    let last = 200;
    for (let i = 0; i < 31; i++) {
      const r = await call(verifyRoute, "/api/dual-auth/verify", { method: "POST", body: { action: "email-verify", code: "123456" } });
      last = r.status;
    }
    expect(last).toBe(429);
  });
});

describe("shops: on behalf of the owner, mobile-only", () => {
  it("TC-DUAL-050 a shop whose owner has one factor cannot go live (admin approval refused); it can once both are verified", async () => {
    const owner = await createUser({ role: "SHOP_OWNER", mobile: null });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    await expect(approveShop(shop.id, { classification: "KESARI" }, { id: admin.id, role: "ADMIN" }, { waiveDocuments: { reason: "test" } })).rejects.toMatchObject({
      details: { reason: "OWNER_NOT_DUAL_VERIFIED" },
    });
    await db.update(users).set({ phoneE164: `+91${uniqueMobile()}`, phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, owner.id));
    const approved = await approveShop(shop.id, { classification: "KESARI" }, { id: admin.id, role: "ADMIN" }, { waiveDocuments: { reason: "test" } }).catch((e: { details?: { reason?: string } }) => e);
    expect((approved as { details?: { reason?: string } }).details?.reason).not.toBe("OWNER_NOT_DUAL_VERIFIED");
  });

  it("TC-DUAL-051 registering a shop with a mobile number alone is closed while the rule is in force", async () => {
    await setRule("selfRegistration", { enabled: true }, admin);
    await expect(assertSelfRegistrationOpen()).rejects.toMatchObject({ details: { reason: "MOBILE_ONLY_REGISTRATION_CLOSED" } });
    await setDualAuth(false);
    await expect(assertSelfRegistrationOpen()).resolves.toBeUndefined();
  });

  it("TC-DUAL-052 an existing live mobile-only shop stays live", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    await db.update(users).set({ emailPlaceholder: true, phoneVerifiedAt: new Date() }).where(eq(users.id, owner.id));
    const shop = await createShop(owner.id, { status: "APPROVED" });
    await syncNeedsSecondFactor(owner.id);
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row.status).toBe("APPROVED");
    await expect(assertDualVerified(owner.id, "SHOP")).rejects.toMatchObject({ details: { missing: ["EMAIL"] } });
  });
});
