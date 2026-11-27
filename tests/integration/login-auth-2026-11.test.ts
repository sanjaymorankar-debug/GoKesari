/**
 * Login & auth — owner prompt 27-Nov-2026 (docs/dual-auth-2026-11): device trust by role (customers 180 days rolling,
 * capped at first trust + 365; others 30 days fixed), the e-mail link for mobile-only accounts, reminders for every
 * account with a missing factor, and the straight-after-sign-in verification on /onboarding.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import OnboardingPage from "@/app/onboarding/page";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, featureFlags, loginOtps, notificationDeliveries, notifications, platformSettings, trustedDevices, users, type User } from "@/server/db/schema";
import { DEVICE_COOKIE, isDeviceTrusted, trustThisDevice } from "@/server/dual-auth/devices";
import { DIFFERENT_ACCOUNTS, factorState, syncNeedsSecondFactor } from "@/server/dual-auth/policy";
import { runSecondFactorReminders } from "@/server/dual-auth/reminders";
import { EMAIL_LINK_INVALID, confirmEmailFactorLink, readEmailFactorLink, sendEmailFactorLink } from "@/server/dual-auth/verify";
import { secondFactorKind } from "@/server/otp/second-factor";
import { placeholderEmailFor } from "@/lib/placeholder-email";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { createShop, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

const DAY = 86_400_000;

async function setDualAuth(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "dual_auth", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["otp", "dualAuth"]));
  clearRuleCache();
}

beforeEach(async () => {
  state.outbox = [];
  state.cookies.clear();
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await db.delete(loginOtps);
  await db.delete(trustedDevices);
  await clearMyRules();
  await setDualAuth(true);
});

afterEach(async () => {
  await clearMyRules();
  await db.delete(featureFlags).where(eq(featureFlags.key, "dual_auth"));
  clearFeatureFlagCache();
});

async function dualVerified(role: UserRole = "CUSTOMER") {
  const user = await createUser({ role, mobile: uniqueMobile() });
  const [row] = await db.update(users).set({ phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, user.id)).returning();
  return row;
}

/** A mobile-only account (registered by SMS): placeholder e-mail, mobile verified. */
async function mobileOnly() {
  const mobile = uniqueMobile();
  const e164 = `+91${mobile}`;
  const [row] = await db
    .insert(users)
    .values({ email: placeholderEmailFor(e164), emailPlaceholder: true, phoneE164: e164, phone: mobile, phoneVerifiedAt: new Date(), role: "CUSTOMER" })
    .returning();
  return row;
}

function signInAs(user: User) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function deviceRow(userId: string) {
  const [row] = await db.select().from(trustedDevices).where(eq(trustedDevices.userId, userId));
  return row;
}

const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

describe("LA-6 device trust by role", () => {
  it("LA-6.1 customer 180 days; shop owner, dealer, rider, society admin 30 days", async () => {
    const expected: [UserRole, number][] = [["CUSTOMER", 180], ["SHOP_OWNER", 30], ["DEALER", 30], ["DELIVERY_PARTNER", 30], ["SOCIETY_ADMIN", 30]];
    for (const [role, n] of expected) {
      state.cookies.clear();
      const user = await dualVerified(role);
      expect(await trustThisDevice(user.id, "test")).toBe(true);
      const row = await deviceRow(user.id);
      expect(days(row.expiresAt, row.trustedAt), role).toBe(n);
      expect(await secondFactorKind(user, "EMAIL"), role).toBeNull();
    }
  });

  it("LA-6.2 a customer's trust is renewed at every sign-in on the device (rolling), never past first trust + 365 days", async () => {
    const user = await dualVerified("CUSTOMER");
    await trustThisDevice(user.id, "test");
    // 100 days later, 80 days left: a sign-in moves it to now + 180.
    await db.update(trustedDevices).set({ trustedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() + 80 * DAY) }).where(eq(trustedDevices.userId, user.id));
    expect(await secondFactorKind(user, "EMAIL")).toBeNull();
    expect(days((await deviceRow(user.id)).expiresAt, new Date())).toBe(180);
    // 300 days after the first trust: capped at first trust + 365 (65 days from now).
    await db.update(trustedDevices).set({ trustedAt: new Date(Date.now() - 300 * DAY), expiresAt: new Date(Date.now() + 10 * DAY) }).where(eq(trustedDevices.userId, user.id));
    expect(await secondFactorKind(user, "EMAIL")).toBeNull();
    expect(days((await deviceRow(user.id)).expiresAt, new Date())).toBe(65);
    // A check outside sign-in does not renew.
    await db.update(trustedDevices).set({ expiresAt: new Date(Date.now() + 5 * DAY) }).where(eq(trustedDevices.userId, user.id));
    expect(await isDeviceTrusted(user.id)).toBe(true);
    expect(days((await deviceRow(user.id)).expiresAt, new Date())).toBe(5);
  });

  it("LA-6.3 a shop owner's 30 days are fixed (no renewal)", async () => {
    const user = await dualVerified("SHOP_OWNER");
    await trustThisDevice(user.id, "test");
    const before = (await deviceRow(user.id)).expiresAt;
    expect(await secondFactorKind(user, "EMAIL")).toBeNull();
    expect((await deviceRow(user.id)).expiresAt.getTime()).toBe(before.getTime());
  });

  it("LA-6.4 a customer who becomes a shop owner gets the 30-day rule from the next sign-in", async () => {
    const user = await dualVerified("CUSTOMER");
    await trustThisDevice(user.id, "test");
    await db.update(trustedDevices).set({ trustedAt: new Date(Date.now() - 40 * DAY) }).where(eq(trustedDevices.userId, user.id));
    expect(await isDeviceTrusted(user.id)).toBe(true);
    const [owner] = await db.update(users).set({ role: "SHOP_OWNER" }).where(eq(users.id, user.id)).returning();
    expect(await secondFactorKind(owner, "EMAIL")).toBe("SMS");
  });

  it("LA-6.5 staff are never trusted: both codes at every sign-in", async () => {
    for (const role of ["ADMIN", "OPERATOR"] as const) {
      state.cookies.clear();
      const user = await dualVerified(role);
      await trustThisDevice(user.id, "test");
      expect(await secondFactorKind(user, "EMAIL"), role).toBe("SMS");
    }
  });
});

describe("LA-4 e-mail verified by link for a mobile-only account", () => {
  function linkFrom(to: string): string {
    const message = [...state.outbox].reverse().find((m) => m.to === to);
    const t = message?.text.match(/[?&]t=([^&\s]+)/)?.[1];
    if (!t) throw new Error(`no link was e-mailed to ${to}`);
    return t;
  }

  it("LA-4.1 the link (bound to the account and the new address) verifies and saves it; it works once", async () => {
    const user = await mobileOnly();
    state.cookies.set(DEVICE_COOKIE, "a".repeat(43));
    const sent = await sendEmailFactorLink(user.id, "New.Person@Example.com", null, "/cart");
    expect(sent.sentTo).toBe("ne***@example.com");
    const t = linkFrom("new.person@example.com");
    expect(await readEmailFactorLink(t)).toEqual({ maskedEmail: "ne***@example.com" });
    const state1 = await confirmEmailFactorLink(t, null, user.id);
    expect(state1.missing).toEqual([]);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ email: "new.person@example.com", emailPlaceholder: false });
    expect(row.emailVerified).not.toBeNull();
    expect(row.needsSecondFactor).toBe(false);
    expect(await deviceRow(user.id)).toBeDefined(); // same browser, same account: trusted
    expect(await readEmailFactorLink(t)).toBeNull();
    await expect(confirmEmailFactorLink(t, null, user.id)).rejects.toThrow(EMAIL_LINK_INVALID);
  });

  it("LA-4.2 only the newest link works; a wrong token never does", async () => {
    const user = await mobileOnly();
    await sendEmailFactorLink(user.id, "one@example.com", null);
    const first = linkFrom("one@example.com");
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 60_000) });
    await sendEmailFactorLink(user.id, "two@example.com", null);
    const second = linkFrom("two@example.com");
    await expect(confirmEmailFactorLink(first, null, null)).rejects.toThrow(EMAIL_LINK_INVALID);
    await expect(confirmEmailFactorLink(`${second.split(".")[0]}.${"x".repeat(43)}`, null, null)).rejects.toThrow(EMAIL_LINK_INVALID);
    await confirmEmailFactorLink(second, null, null);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.email).toBe("two@example.com");
    // Opened without this account signed in: verified, but no device trusted.
    expect(await deviceRow(user.id)).toBeUndefined();
  });

  it("LA-4.3 an address on another account: DIFFERENT_ACCOUNTS, logged for admin review, nothing saved", async () => {
    await createUser({ email: "taken@example.com" });
    const user = await mobileOnly();
    await sendEmailFactorLink(user.id, "taken@example.com", null);
    await expect(confirmEmailFactorLink(linkFrom("taken@example.com"), null, user.id)).rejects.toThrow(DIFFERENT_ACCOUNTS);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.emailPlaceholder).toBe(true);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.account_conflict")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(audit?.newValue).toMatchObject({ kind: "EMAIL", where: "verify_email_link", status: "OPEN" });
  });

  it("LA-4.4 a resend within 30 seconds is refused", async () => {
    const user = await mobileOnly();
    await sendEmailFactorLink(user.id, "again@example.com", null);
    await expect(sendEmailFactorLink(user.id, "again@example.com", null)).rejects.toThrow(/wait/i);
  });
});

describe("LA-7 reminders for every account with a missing factor", () => {
  const noonIst = () => {
    const d = new Date();
    d.setUTCHours(6, 30, 0, 0); // 12:00 IST
    return d;
  };

  it("LA-7.1 customers get in-app + e-mail (+ SMS when a number is on file); shop owners in-app + SMS; nothing outside 10–19 IST", async () => {
    const customer = await createUser({ role: "CUSTOMER", mobile: uniqueMobile() }); // e-mail verified, mobile not
    const owner = await mobileOnly();
    await db.update(users).set({ role: "SHOP_OWNER" }).where(eq(users.id, owner.id));
    await createShop(owner.id);
    await syncNeedsSecondFactor(customer.id);
    await syncNeedsSecondFactor(owner.id);
    const late = new Date(noonIst().getTime() + 9 * 3_600_000); // 21:00 IST
    expect(await runSecondFactorReminders(late)).toMatchObject({ skipped: "outside_10_19_ist" });
    const run = await runSecondFactorReminders(noonIst());
    expect(run.reminded).toBe(2);
    // In-app rows in notifications; e-mail / SMS copies in notification_deliveries.
    const channelsOf = async (userId: string) => {
      const inApp = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "security.second_factor_needed")));
      const out = inApp.length
        ? await db.select({ channel: notificationDeliveries.channel }).from(notificationDeliveries).where(inArray(notificationDeliveries.notificationId, inApp.map((r) => r.id)))
        : [];
      return [...(inApp.length ? ["IN_APP"] : []), ...out.map((r) => r.channel)].sort();
    };
    expect(await channelsOf(customer.id)).toEqual(expect.arrayContaining(["IN_APP", "EMAIL", "SMS"]));
    expect(await channelsOf(owner.id)).toEqual(expect.arrayContaining(["IN_APP", "SMS"]));
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.second_factor_reminder"));
    expect(audits.map((a) => (a.newValue as { shopOwner: boolean }).shopOwner).sort()).toEqual([false, true]);
    // Not again for 3 days.
    expect((await runSecondFactorReminders(noonIst())).reminded).toBe(0);
  });

  it("LA-7.2 an account with both factors is never reminded", async () => {
    const user = await dualVerified("CUSTOMER");
    await db.update(users).set({ needsSecondFactor: true }).where(eq(users.id, user.id));
    expect((await runSecondFactorReminders(noonIst())).reminded).toBe(0);
    expect((await factorState(user)).missing).toEqual([]);
  });
});

describe("LA-3 verification straight after sign-in", () => {
  it("LA-3.1 a one-factor account landing on /onboarding goes to /account/verify first (no skip), then comes back", async () => {
    const user = await mobileOnly();
    signInAs(user);
    await expect(OnboardingPage()).rejects.toThrow(`REDIRECT:/account/verify?return=${encodeURIComponent("/onboarding")}`);
  });

  it("LA-3.2 dual_auth off: nothing is asked here", async () => {
    await setDualAuth(false);
    const user = await mobileOnly();
    signInAs(user);
    const result = await OnboardingPage().catch((e: Error) => e);
    expect(result instanceof Error ? result.message : "").not.toMatch(/account\/verify/);
  });

  it("LA-3.3 both factors verified: straight on", async () => {
    const user = await dualVerified("CUSTOMER");
    signInAs(user);
    const result = await OnboardingPage().catch((e: Error) => e);
    expect(result instanceof Error ? result.message : "").not.toMatch(/account\/verify/);
  });
});
