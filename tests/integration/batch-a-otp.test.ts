/**
 * batch-2026-10 WS-A — F1.1.2 OTP by email (GS-001, GS-074): 6 digits, 5-minute
 * expiry, 5 attempts, resend cooldown, limits per email / user / IP counted in
 * the database, hashed codes, provider routing (SMS gated by rule), audit, and
 * the purge of old codes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  outbox: [] as { to: string; subject: string; text: string }[],
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

import { NextRequest } from "next/server";

import { POST as housekeepingRoute } from "@/app/api/cron/auth-housekeeping/route";
import { POST as emailRequestRoute } from "@/app/api/profile/email/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, loginOtps, outboundTestMessages, platformSettings, users } from "@/server/db/schema";
import { placeholderEmailFor } from "@/lib/placeholder-email";
import { purgeExpiredOtps } from "@/server/otp/housekeeping";
import { emailOtpProvider, getOtpProvider, phase2SmsOtpProvider, SmsOtpProvider } from "@/server/otp/providers";
import { OTP_INVALID, requestEmailChangeOtp, requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { RULES } from "@/server/config/rules";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["otp", "otpHousekeeping", "onlinePayments"]));
  clearRuleCache();
}

beforeEach(async () => {
  state.outbox = [];
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await db.delete(loginOtps);
  await clearMyRules();
});

afterEach(clearMyRules);

function lastCodeTo(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

/** Puts n older codes on record (past the cooldown, inside the window). */
async function seedCodes(n: number, values: Partial<typeof loginOtps.$inferInsert>) {
  const createdAt = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < n; i++) {
    await db.insert(loginOtps).values({
      email: `seed-${i}-${Math.random().toString(36).slice(2)}@example.com`,
      purpose: "LOGIN",
      channel: "EMAIL",
      codeHash: "x:y",
      expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
      maxAttempts: 5,
      createdAt,
      ...values,
    });
  }
}

describe("code shape and storage", () => {
  it("TC-B26-A-050 a 6-digit code that expires in 5 minutes, stored only as a salted HMAC", async () => {
    expect(RULES.otp.defaults).toMatchObject({ length: 6, expiryMinutes: 5, maxAttempts: 5, resendCooldownSeconds: 60 });
    const sent = await requestLoginOtp({ email: "shape@example.com" });
    expect(sent).toMatchObject({ status: "SENT", expiryMinutes: 5 });
    const code = lastCodeTo("shape@example.com");
    expect(code).toMatch(/^\d{6}$/);
    expect(state.outbox[0].text).toContain("5 minutes");
    const [row] = await db.select().from(loginOtps).where(eq(loginOtps.email, "shape@example.com"));
    const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(lifetime).toBeGreaterThan(4.9 * 60_000);
    expect(lifetime).toBeLessThan(5.1 * 60_000);
    expect(row.codeHash).toMatch(/^[0-9a-f]{16}:[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
  });

  it("TC-B26-A-051 a code past its 5 minutes is refused", async () => {
    await requestLoginOtp({ email: "late5@example.com" });
    const code = lastCodeTo("late5@example.com");
    await db.update(loginOtps).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(loginOtps.email, "late5@example.com"));
    await expect(verifyLoginOtp({ email: "late5@example.com", code })).rejects.toThrow(OTP_INVALID);
  });

  it("TC-B26-A-052 five wrong attempts lock the code, even for the right digits", async () => {
    await requestLoginOtp({ email: "five@example.com" });
    const code = lastCodeTo("five@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyLoginOtp({ email: "five@example.com", code: wrong })).rejects.toThrow(OTP_INVALID);
    await expect(verifyLoginOtp({ email: "five@example.com", code })).rejects.toThrow(/Too many wrong attempts/);
  });
});

describe("rate limits", () => {
  it("TC-B26-A-053 resend cooldown per email", async () => {
    await requestLoginOtp({ email: "cool@example.com" });
    await expect(requestLoginOtp({ email: "cool@example.com" })).rejects.toThrow(/Please wait \d+ seconds/);
  });

  it("TC-B26-A-054 per email: at most maxResendsPerWindow codes in the window", async () => {
    await seedCodes(5, { email: "window@example.com" });
    await expect(requestLoginOtp({ email: "window@example.com" })).rejects.toThrow(/Too many codes were requested for this email/);
  });

  it("TC-B26-A-055 per user (database-counted): codes to many addresses for one account are capped", async () => {
    const user = await createUser({ email: "owner@example.com" });
    await seedCodes(5, { userId: user.id, purpose: "EMAIL_CHANGE" });
    await expect(requestEmailChangeOtp(user.id, { email: "brand-new@example.com" })).rejects.toThrow(/for this account/);
    const [blocked] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "auth.otp_blocked"), sql`${auditLogs.newValue}->>'reason' = 'user_limit'`));
    expect(blocked).toBeDefined();
    expect(state.outbox).toHaveLength(0);
  });

  it("TC-B26-A-056 per IP (database-counted, shared by every server instance)", async () => {
    await seedCodes(20, { ipAddress: "203.0.113.5" });
    await expect(requestLoginOtp({ email: "fresh@example.com", ip: "203.0.113.5" })).rejects.toThrow(/from this network/);
    await expect(requestLoginOtp({ email: "fresh@example.com", ip: "198.51.100.7" })).resolves.toMatchObject({ status: "SENT" });
  });

  it("TC-B26-A-057 email change route: limited per account as well as per IP", async () => {
    const user = await createUser({ email: "mover@example.com" });
    state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Old codes do not count against the cooldown of a different address; each request is a new address.
      const res = await call(emailRequestRoute, "/api/profile/email", { method: "POST", body: { email: `new-${i}@example.com` } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe("providers", () => {
  it("TC-B26-A-058 codes go through the email OtpProvider with the right wording for each purpose", async () => {
    const spy = vi.spyOn(emailOtpProvider, "send");
    const user = await createUser({ email: "route-a@example.com" });
    await requestLoginOtp({ email: "route-a@example.com" });
    await requestEmailChangeOtp(user.id, { email: "route-b@example.com" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ to: "route-a@example.com", purpose: "LOGIN", expiryMinutes: 5 });
    expect(spy.mock.calls[1][0]).toMatchObject({ to: "route-b@example.com", purpose: "EMAIL_CHANGE" });
    expect(state.outbox[0].subject).toMatch(/sign-in code/);
    expect(state.outbox[1].subject).toMatch(/email confirmation code/);
    spy.mockRestore();
  });

  it("TC-B26-A-059 rule otp.smsEnabled gates the SMS adapter; the Phase 2 SMS provider is a stub", async () => {
    const admin = await createUser({ role: "ADMIN" });
    expect((await getOtpProvider("EMAIL"))?.channel).toBe("EMAIL");
    expect((await getOtpProvider("SMS"))?.channel).toBe("SMS"); // SMS_PROVIDER=mock in tests, rule on by default
    await setRule("otp", { smsEnabled: false }, admin);
    expect(await getOtpProvider("SMS")).toBeNull();
    expect(phase2SmsOtpProvider).toBeInstanceOf(SmsOtpProvider);
    expect(phase2SmsOtpProvider.isAvailable()).toBe(false);
    await expect(phase2SmsOtpProvider.send({ to: "+919800000000", code: "123456", expiryMinutes: 5 })).rejects.toThrow(/Phase 2/);
  });

  it("TC-B26-A-060 a mobile-only shop account gets its code by SMS only while the rule allows it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const mobile = uniqueMobile();
    await db.delete(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
    const [shopOwner] = await db
      .insert(users)
      .values({ email: placeholderEmailFor(`+91${mobile}`), emailPlaceholder: true, phoneE164: `+91${mobile}`, phone: mobile, role: "SHOP_OWNER" })
      .returning();
    expect(shopOwner.emailPlaceholder).toBe(true);
    await requestLoginOtp({ mobile });
    const sent = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
    expect(sent).toHaveLength(1);

    await setRule("otp", { smsEnabled: false }, admin);
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) });
    resetRateLimits();
    await requestLoginOtp({ mobile });
    expect(await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`))).toHaveLength(1);
    expect(state.outbox).toHaveLength(0);
  });

  it("TC-B26-A-061 requests, failures and successes are audited with masked identifiers", async () => {
    await requestLoginOtp({ email: "audited@example.com" });
    const code = lastCodeTo("audited@example.com");
    await expect(verifyLoginOtp({ email: "audited@example.com", code: code === "000000" ? "111111" : "000000" })).rejects.toThrow();
    await verifyLoginOtp({ email: "audited@example.com", code });
    const rows = await db.select().from(auditLogs).where(inArray(auditLogs.action, ["auth.otp_requested", "auth.otp_failed", "auth.otp_verified"]));
    expect(rows.map((r) => r.action).sort()).toEqual(["auth.otp_failed", "auth.otp_requested", "auth.otp_verified"]);
    for (const r of rows) expect(JSON.stringify(r.newValue)).not.toContain("audited@example.com");
  });
});

describe("purge job", () => {
  it("TC-B26-A-062 deletes codes older than the retention, keeps recent ones; the cron route needs the secret", async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await seedCodes(3, { createdAt: old, expiresAt: old });
    await requestLoginOtp({ email: "keep@example.com" });
    const denied = await call(housekeepingRoute, "/api/cron/auth-housekeeping", { method: "POST" });
    expect(denied.status).toBe(403);
    const request = new NextRequest("http://localhost/api/cron/auth-housekeeping", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const response = await housekeepingRoute(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ otps: { deleted: 3 } });
    const left = await db.select().from(loginOtps);
    expect(left.map((r) => r.email)).toEqual(["keep@example.com"]);
    expect((await purgeExpiredOtps()).deleted).toBe(0);
  });

  it("TC-B26-A-063 the purge can be switched off by rule", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("otpHousekeeping", { purgeEnabled: false }, admin);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await seedCodes(1, { createdAt: old, expiresAt: old });
    expect(await purgeExpiredOtps()).toEqual({ deleted: 0, skipped: "disabled" });
    expect(await db.select().from(loginOtps)).toHaveLength(1);
  });
});
