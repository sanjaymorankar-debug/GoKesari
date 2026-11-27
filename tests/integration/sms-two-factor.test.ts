/**
 * docs/sms-2fa-2026-11: the SMS second factor at sign-in (flags
 * sms_otp_signin_customers_enabled / sms_otp_signin_shop_owners_enabled), the
 * checkout step-up code (rule checkoutOtp) and Admin → Sign-in security.
 * SMS_PROVIDER=mock in tests: codes are read from outbound_test_messages.
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";
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
  headers: async () => new Headers(),
}));

import { POST as checkoutRoute } from "@/app/api/checkout/route";
import { GET as checkoutOtpStateRoute, POST as checkoutOtpRoute } from "@/app/api/checkout/otp/route";
import { POST as checkoutOtpVerifyRoute } from "@/app/api/checkout/otp/verify/route";
import { GET as signInSecurityGet, PUT as signInSecurityPut } from "@/app/api/admin/sign-in-security/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { featureFlags, loginOtps, outboundTestMessages, platformSettings, users, type User } from "@/server/db/schema";
import { CHECKOUT_PASS_MINUTES } from "@/server/otp/checkout-step-up";
import { GOOGLE_SIGN_UP_NEEDS_CODE, SECOND_FACTOR_COOKIE, SECOND_FACTOR_PAGE, googleSecondFactorGate } from "@/server/otp/google-second-factor";
import {
  afterEmailFactor,
  createSecondFactorChallenge,
  readSecondFactorChallenge,
  secondFactorRequired,
  sendSecondFactorCode,
  verifySecondFactorCode,
} from "@/server/otp/second-factor";
import { MOBILE_IN_USE, OTP_INVALID, readLoginTicket, requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { addToCart } from "@/server/services/cart";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
  uniqueMobile,
} from "../helpers/fixtures";

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["otp", "checkoutOtp"]));
  clearRuleCache();
}

const FLAGS = { customers: "sms_otp_signin_customers_enabled", shopOwners: "sms_otp_signin_shop_owners_enabled" } as const;

async function setFlag(enabled: boolean, audiences: (keyof typeof FLAGS)[] = ["customers", "shopOwners"]) {
  for (const audience of audiences) {
    await db
      .insert(featureFlags)
      .values({ key: FLAGS[audience], enabled })
      .onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  }
  clearFeatureFlagCache();
}

let admin: User;

beforeEach(async () => {
  state.outbox = [];
  state.cookies.clear();
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await db.delete(loginOtps);
  await clearMyRules();
  admin = await createUser({ role: "ADMIN" });
});

afterEach(async () => {
  await clearMyRules();
  await db.delete(featureFlags).where(inArray(featureFlags.key, Object.values(FLAGS)));
  clearFeatureFlagCache();
});

function lastEmailCode(email: string): string {
  // The newest code e-mail (a "New sign-in" notice to the same address may arrive after it).
  const message = [...state.outbox].reverse().find((m) => m.to === email && /^\d{4,8} /.test(m.subject));
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
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

async function verifiedCustomer(role: UserRole = "CUSTOMER") {
  const mobile = uniqueMobile();
  const user = await createUser({ role, mobile });
  const [row] = await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id)).returning();
  await db.delete(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
  return row;
}

/** The emailed first factor, as the sign-in page runs it. */
async function emailFactor(email: string) {
  await requestLoginOtp({ email });
  const { user } = await verifyLoginOtp({ email, code: lastEmailCode(email) });
  return user;
}

describe("sign-in second factor (flags sms_otp_signin_*_enabled)", () => {
  it("TC-SMS2FA-001 flag off: the emailed code alone signs in, exactly as before", async () => {
    await setFlag(false);
    const user = await verifiedCustomer();
    const signedIn = await emailFactor(user.email);
    const next = await afterEmailFactor(signedIn, null);
    expect(next.ticket && readLoginTicket(next.ticket)).toBe(user.id);
    expect(next.secondFactor).toBeUndefined();
  });

  it("TC-SMS2FA-002 flag on: no session after the email code; an SMS code to the verified mobile is needed too", async () => {
    await setFlag(true);
    const user = await verifiedCustomer();
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    expect(next.ticket).toBeUndefined();
    expect(next.secondFactor).toMatchObject({ needsPhone: false, sendError: null, expiryMinutes: 5 });
    expect(next.secondFactor!.maskedPhone).toContain(user.phoneE164!.slice(-4));
    expect(readSecondFactorChallenge(next.secondFactor!.challenge)).toBe(user.id);

    const code = await lastSmsCode(user.phoneE164!);
    await expect(verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code: code === "000000" ? "111111" : "000000" })).rejects.toThrow(OTP_INVALID);
    const done = await verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code });
    expect(done.id).toBe(user.id);
    // Single use.
    await expect(verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code })).rejects.toThrow(OTP_INVALID);
    const [row] = await db.select().from(loginOtps).where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, "LOGIN_SMS")));
    expect(row).toMatchObject({ channel: "SMS", phoneE164: user.phoneE164 });
    expect(row.consumedAt).not.toBeNull();
  });

  it("TC-SMS2FA-003 an account without a verified mobile gives its number; the SMS code sets phone + phoneVerifiedAt", async () => {
    await setFlag(true);
    const user = await createUser({ role: "SHOP_OWNER", mobile: null });
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    expect(next.secondFactor).toMatchObject({ needsPhone: true, maskedPhone: null });
    const challenge = next.secondFactor!.challenge;

    await expect(sendSecondFactorCode({ challenge })).rejects.toThrow(/mobile number/);
    const mobile = uniqueMobile();
    const sent = await sendSecondFactorCode({ challenge, mobile });
    expect(sent.maskedPhone).toContain(mobile.slice(-4));
    const code = await lastSmsCode(`+91${mobile}`);
    // The code is bound to the number it went to.
    await expect(verifySecondFactorCode({ challenge, code, mobile: uniqueMobile() })).rejects.toThrow(OTP_INVALID);
    const done = await verifySecondFactorCode({ challenge, code, mobile });
    expect(done.phoneE164).toBe(`+91${mobile}`);
    expect(done.phone).toBe(mobile);
    expect(done.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("TC-SMS2FA-004 a number on another account is refused before any SMS is sent", async () => {
    await setFlag(true);
    const other = await createUser();
    const user = await createUser({ mobile: null });
    const challenge = createSecondFactorChallenge(user.id);
    await expect(sendSecondFactorCode({ challenge, mobile: other.phone! })).rejects.toThrow(MOBILE_IN_USE);
  });

  it("TC-SMS2FA-005 wrong SMS codes lock the code after maxAttempts (5), like the email code", async () => {
    await setFlag(true);
    const user = await verifiedCustomer();
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    const challenge = next.secondFactor!.challenge;
    const code = await lastSmsCode(user.phoneE164!);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await expect(verifySecondFactorCode({ challenge, code: wrong })).rejects.toThrow(OTP_INVALID);
    await expect(verifySecondFactorCode({ challenge, code })).rejects.toThrow(/Too many wrong attempts/);
  });

  it("TC-SMS2FA-006 resend cooldown applies to SMS codes", async () => {
    await setFlag(true);
    const user = await verifiedCustomer();
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    await expect(sendSecondFactorCode({ challenge: next.secondFactor!.challenge })).rejects.toThrow(/wait \d+ seconds/);
  });

  it("TC-SMS2FA-007 SMS unavailable (rule otp.smsEnabled off) → email only, nobody locked out", async () => {
    await setFlag(true);
    await setRule("otp", { smsEnabled: false }, admin);
    const user = await verifiedCustomer();
    expect(await secondFactorRequired(user)).toBe(false);
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    expect(next.ticket && readLoginTicket(next.ticket)).toBe(user.id);
  });

  it("TC-SMS2FA-008 each switch gates only its own audience; other roles are never asked", async () => {
    const customer = await verifiedCustomer("CUSTOMER");
    const owner = await verifiedCustomer("SHOP_OWNER");
    await setFlag(true, ["customers"]);
    expect(await secondFactorRequired(customer)).toBe(true);
    expect(await secondFactorRequired(owner)).toBe(false);
    await setFlag(false, ["customers"]);
    await setFlag(true, ["shopOwners"]);
    expect(await secondFactorRequired(customer)).toBe(false);
    expect(await secondFactorRequired(owner)).toBe(true);
    await setFlag(true);
    for (const role of ["ADMIN", "DELIVERY_PARTNER", "DEALER", "OPERATOR"] as const) {
      expect(await secondFactorRequired(await verifiedCustomer(role))).toBe(false);
    }
  });

  it("TC-SMS2FA-011 switching off returns the audience to email-only at once; verified mobiles stay verified", async () => {
    await setFlag(true);
    const user = await verifiedCustomer();
    expect((await afterEmailFactor(await emailFactor(user.email), null)).secondFactor).toBeDefined();
    await setFlag(false, ["customers"]);
    // Past the 60 s resend cooldown.
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 2 * 60_000) }).where(eq(loginOtps.email, user.email));
    const next = await afterEmailFactor(await emailFactor(user.email), null);
    expect(next.ticket && readLoginTicket(next.ticket)).toBe(user.id);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("TC-SMS2FA-009 a forged or expired challenge is refused", async () => {
    const user = await verifiedCustomer();
    const good = createSecondFactorChallenge(user.id);
    expect(readSecondFactorChallenge(good)).toBe(user.id);
    expect(readSecondFactorChallenge(`${good}x`)).toBeNull();
    expect(readSecondFactorChallenge(createSecondFactorChallenge(user.id, Date.now() - 16 * 60_000))).toBeNull();
    await expect(sendSecondFactorCode({ challenge: "nope" })).rejects.toThrow(/expired/);
  });

  it("TC-SMS2FA-010 Google: an account needing the factor goes to the SMS page (challenge cookie); flag off → straight in", async () => {
    const user = await verifiedCustomer();
    await setFlag(false);
    expect(await googleSecondFactorGate(user.email)).toBe(true);
    await setFlag(true);
    expect(await googleSecondFactorGate(user.email)).toBe(SECOND_FACTOR_PAGE);
    expect(readSecondFactorChallenge(state.cookies.get(SECOND_FACTOR_COOKIE)!)).toBe(user.id);
    // A new Google account cannot be created while the factor is on for customers.
    expect(await googleSecondFactorGate("brand-new-google@example.com")).toBe(`/signin?error=${GOOGLE_SIGN_UP_NEEDS_CODE}`);
    expect(await googleSecondFactorGate(admin.email)).toBe(true);
  });
});

/* ------------------------------------------------------------ checkout */

function signInAs(user: User) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function customerWithCart() {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
  await db.delete(outboundTestMessages).where(eq(outboundTestMessages.toAddress, user.phoneE164!));
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id);
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 50 });
  await addToCart(user.id, shopProduct.id, 1);
  signInAs(user);
  return { user, shopProduct, addressId: await deliveryAddressId(user.id) };
}

const placeOrder = (requestId: string, addressId: string) =>
  call(checkoutRoute, "/api/checkout", { method: "POST", body: { requestId, addressId } });

async function verifyCheckoutCode(e164: string) {
  const sent = await call(checkoutOtpRoute, "/api/checkout/otp", { method: "POST", body: {} });
  expect(sent.status).toBe(200);
  const verified = await call(checkoutOtpVerifyRoute, "/api/checkout/otp/verify", { method: "POST", body: { code: await lastSmsCode(e164) } });
  expect(verified.status).toBe(200);
  return verified.body;
}

describe("checkout step-up (rule checkoutOtp)", () => {
  it("TC-SMS2FA-020 rule off (default): orders are placed without a code", async () => {
    const { addressId } = await customerWithCart();
    expect((await placeOrder("sms-off-1", addressId)).status).toBe(201);
  });

  it("TC-SMS2FA-021 every_checkout: refused without a fresh code, placed after one, and the next order needs a new one", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "every_checkout" }, admin);
    const { user, shopProduct, addressId } = await customerWithCart();

    const refused = await placeOrder("sms-every-1", addressId);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toMatchObject({ stepUp: "CHECKOUT_OTP", needsPhone: false, mode: "every_checkout" });
    expect((await call(checkoutOtpStateRoute, "/api/checkout/otp")).body).toMatchObject({ required: true, satisfied: false });

    await verifyCheckoutCode(user.phoneE164!);
    const placed = await placeOrder("sms-every-1", addressId);
    expect(placed.status).toBe(201);
    // A retry of the same request is the same order, not a new code.
    const replay = await placeOrder("sms-every-1", addressId);
    expect(replay.status).toBe(201);
    expect(replay.body.deduplicated).toBe(true);

    await addToCart(user.id, shopProduct.id, 1);
    expect((await placeOrder("sms-every-2", addressId)).status).toBe(403);
  });

  it("TC-SMS2FA-022 every_checkout: a code older than the pass window does not count", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "every_checkout" }, admin);
    const { user, addressId } = await customerWithCart();
    await verifyCheckoutCode(user.phoneE164!);
    await db
      .update(loginOtps)
      .set({ consumedAt: new Date(Date.now() - (CHECKOUT_PASS_MINUTES + 1) * 60_000) })
      .where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, "CHECKOUT")));
    expect((await placeOrder("sms-stale-1", addressId)).status).toBe(403);
  });

  it("TC-SMS2FA-023 a failed checkout gives the pass back", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "every_checkout" }, admin);
    const { user, addressId } = await customerWithCart();
    await verifyCheckoutCode(user.phoneE164!);
    await db.update(users).set({ phoneE164: user.phoneE164 }).where(eq(users.id, user.id));
    // An unknown address fails the checkout after the pass was claimed.
    const failed = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "sms-fail-1", addressId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(failed.status).not.toBe(201);
    expect(failed.status).not.toBe(403);
    const [pass] = await db.select().from(loginOtps).where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, "CHECKOUT")));
    expect(pass.stepUpRequestId).toBeNull();
    expect((await placeOrder("sms-fail-2", addressId)).status).toBe(201);
  });

  it("TC-SMS2FA-024 once_per_hours: one code covers several orders until `hours` have passed", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "once_per_hours", hours: 12 }, admin);
    const { user, shopProduct, addressId } = await customerWithCart();
    expect((await placeOrder("sms-hours-1", addressId)).status).toBe(403);
    await verifyCheckoutCode(user.phoneE164!);
    expect((await placeOrder("sms-hours-1", addressId)).status).toBe(201);
    await addToCart(user.id, shopProduct.id, 1);
    expect((await placeOrder("sms-hours-2", addressId)).status).toBe(201);

    await db
      .update(loginOtps)
      .set({ consumedAt: new Date(Date.now() - 13 * 3_600_000) })
      .where(and(eq(loginOtps.userId, user.id), eq(loginOtps.purpose, "CHECKOUT")));
    await addToCart(user.id, shopProduct.id, 1);
    expect((await placeOrder("sms-hours-3", addressId)).status).toBe(403);
  });

  it("TC-SMS2FA-025 no verified mobile: the number is given in the step and saved as verified", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "every_checkout" }, admin);
    const { user, addressId } = await customerWithCart();
    await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, user.id));
    const refused = await placeOrder("sms-nophone-1", addressId);
    expect(refused.body.error.details).toMatchObject({ needsPhone: true, maskedPhone: null });
    const noNumber = await call(checkoutOtpRoute, "/api/checkout/otp", { method: "POST", body: {} });
    expect(noNumber.status).toBe(422);
    const sent = await call(checkoutOtpRoute, "/api/checkout/otp", { method: "POST", body: { mobile: user.phone } });
    expect(sent.status).toBe(200);
    const ok = await call(checkoutOtpVerifyRoute, "/api/checkout/otp/verify", {
      method: "POST",
      body: { code: await lastSmsCode(user.phoneE164!), mobile: user.phone },
    });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.phoneVerifiedAt).toBeInstanceOf(Date);
    expect((await placeOrder("sms-nophone-1", addressId)).status).toBe(201);
  });

  it("TC-SMS2FA-026 rule on but SMS unavailable here: orders go through without a code", async () => {
    await setRule("checkoutOtp", { enabled: true, mode: "every_checkout" }, admin);
    await setRule("otp", { smsEnabled: false }, admin);
    const { addressId } = await customerWithCart();
    expect((await placeOrder("sms-unavail-1", addressId)).status).toBe(201);
  });
});

/* ------------------------------------------------- Admin → Sign-in security */

describe("Admin → Sign-in security (GET/PUT /api/admin/sign-in-security)", () => {
  it("TC-SMS2FA-030 refuses everyone but an admin", async () => {
    for (const role of ["CUSTOMER", "SHOP_OWNER", "OPERATOR"] as const) {
      signInAs(await createUser({ role }));
      expect((await call(signInSecurityGet, "/api/admin/sign-in-security")).status).toBe(403);
      const put = await call(signInSecurityPut, "/api/admin/sign-in-security", {
        method: "PUT",
        body: { kind: "audience", audience: "customers", enabled: true, reason: "trying it out" },
      });
      expect(put.status).toBe(403);
    }
    state.session = null;
    expect((await call(signInSecurityGet, "/api/admin/sign-in-security")).status).toBe(401);
  });

  it("TC-SMS2FA-031 an admin switches each audience with a reason (logged) and sets the checkout code", async () => {
    signInAs(admin);
    const before = await call(signInSecurityGet, "/api/admin/sign-in-security");
    expect(before.status).toBe(200);
    expect(before.body.provider).toMatchObject({ mode: "mock", available: true });
    expect(JSON.stringify(before.body)).not.toMatch(/MSG91_AUTH_KEY|authkey/i);
    expect(before.body.audiences.map((a: { audience: string; enabled: boolean }) => [a.audience, a.enabled])).toEqual([
      ["customers", false],
      ["shopOwners", false],
    ]);

    const noReason = await call(signInSecurityPut, "/api/admin/sign-in-security", {
      method: "PUT",
      body: { kind: "audience", audience: "shopOwners", enabled: true, reason: "" },
    });
    expect(noReason.status).toBe(422);

    const on = await call(signInSecurityPut, "/api/admin/sign-in-security", {
      method: "PUT",
      body: { kind: "audience", audience: "shopOwners", enabled: true, reason: "pilot for shop owners" },
    });
    expect(on.status).toBe(200);
    expect(await secondFactorRequired(await verifiedCustomer("SHOP_OWNER"))).toBe(true);
    expect(await secondFactorRequired(await verifiedCustomer("CUSTOMER"))).toBe(false);

    const checkout = await call(signInSecurityPut, "/api/admin/sign-in-security", {
      method: "PUT",
      body: { kind: "checkout", enabled: true, mode: "once_per_hours", hours: 6 },
    });
    expect(checkout.status).toBe(200);

    const after = await call(signInSecurityGet, "/api/admin/sign-in-security");
    const owners = after.body.audiences.find((a: { audience: string }) => a.audience === "shopOwners");
    expect(owners).toMatchObject({ enabled: true, inForce: true });
    expect(owners.lastChange).toMatchObject({ reason: "pilot for shop owners", byEmail: admin.email, enabled: true });
    expect(after.body.checkout).toMatchObject({ enabled: true, mode: "once_per_hours", hours: 6, inForce: true });
    expect(after.body.stats.shopOwners.verifiedMobile).toBeGreaterThanOrEqual(1);
  });

  it("TC-SMS2FA-032 with SMS unavailable the page says so and no switch is in force", async () => {
    signInAs(admin);
    await setRule("otp", { smsEnabled: false }, admin);
    await setFlag(true);
    const r = await call(signInSecurityGet, "/api/admin/sign-in-security");
    expect(r.body.provider.available).toBe(false);
    expect(r.body.provider.problem).toMatch(/smsEnabled/);
    expect(r.body.audiences.every((a: { inForce: boolean }) => !a.inForce)).toBe(true);
  });
});

// Keep the mock outbox small for other suites.
afterEach(async () => {
  await db.delete(outboundTestMessages).where(like(outboundTestMessages.body, "%GoKesari account verification OTP%"));
});

describe("mobile-number sign-in by SMS (owner 26-Nov-2026)", () => {
  it("TC-SMSLOGIN-001 a mobile already verified by SMS gets its sign-in code by SMS, and the code signs in", async () => {
    const user = await verifiedCustomer();
    const mobile = user.phoneE164!.slice(3);
    state.outbox = [];
    await requestLoginOtp({ mobile });
    const code = await lastSmsCode(user.phoneE164!);
    expect(state.outbox.filter((m) => m.to === user.email)).toHaveLength(0);
    const { user: signedIn } = await verifyLoginOtp({ mobile, email: null, code });
    expect(signedIn.id).toBe(user.id);
  });

  it("TC-SMSLOGIN-002 a mobile never verified by SMS gets the code by SMS; the account's e-mail code is asked too (safety step, owner 27-Nov-2026), and only then is the mobile verified", async () => {
    const mobile = uniqueMobile();
    const user = await createUser({ mobile });
    await db.update(users).set({ emailVerified: null }).where(eq(users.id, user.id));
    await db.delete(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
    state.outbox = [];
    await requestLoginOtp({ mobile });
    const code = await lastSmsCode(`+91${mobile}`);
    expect(state.outbox.filter((m) => m.to === user.email)).toHaveLength(0);
    const { user: signedIn, channel } = await verifyLoginOtp({ mobile, code });
    expect(channel).toBe("SMS");
    expect(signedIn.id).toBe(user.id);
    // The SMS code alone does not prove a number that was typed in: not verified yet, no session yet.
    let [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneVerifiedAt).toBeNull();
    const next = await afterEmailFactor(row, null, "SMS");
    expect(next.secondFactor?.kind).toBe("EMAIL");
    expect(next.secondFactor?.sendError ?? null).toBeNull();
    expect(next.ticket).toBeUndefined();
    const emailCode = lastEmailCode(user.email);
    await expect(verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code: emailCode === "000000" ? "111111" : "000000" })).rejects.toThrow(OTP_INVALID);
    expect((await verifySecondFactorCode({ challenge: next.secondFactor!.challenge, code: emailCode })).id).toBe(user.id);
    [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect(row.emailVerified).not.toBeNull();
  });

  it("TC-SMSLOGIN-006 safety step with dual_auth off and on a trusted device too; once verified, the SMS code alone signs in", async () => {
    const mobile = uniqueMobile();
    const user = await createUser({ mobile });
    await requestLoginOtp({ mobile });
    const { user: first } = await verifyLoginOtp({ mobile, code: await lastSmsCode(`+91${mobile}`) });
    const step = await afterEmailFactor(first, null, "SMS");
    expect(step.secondFactor?.kind).toBe("EMAIL");
    expect(step.secondFactor?.sendError ?? null).toBeNull();
    await verifySecondFactorCode({ challenge: step.secondFactor!.challenge, code: lastEmailCode(user.email) });
    // Next time (dual_auth off): the verified number signs in with its SMS code alone.
    await db.update(loginOtps).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) });
    resetRateLimits();
    await requestLoginOtp({ mobile });
    const { user: again } = await verifyLoginOtp({ mobile, code: await lastSmsCode(`+91${mobile}`) });
    expect((await afterEmailFactor(again, null, "SMS")).ticket).toBeTruthy();
  });

  it("TC-SMSLOGIN-007 a mobile-only account (placeholder e-mail) is verified by its SMS code alone — no e-mail to ask", async () => {
    const mobile = uniqueMobile();
    await requestLoginOtp({ mobile });
    const { user, isNewUser } = await verifyLoginOtp({ mobile, code: await lastSmsCode(`+91${mobile}`), acceptedTerms: true });
    expect(isNewUser).toBe(true);
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.emailPlaceholder).toBe(true);
    expect((await afterEmailFactor(user, null, "SMS")).ticket).toBeTruthy();
  });

  it("TC-SMSLOGIN-004 a new mobile number gets its code by SMS; with the Terms ticked the code creates a mobile-only account", async () => {
    const mobile = uniqueMobile();
    await db.delete(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
    state.outbox = [];
    await requestLoginOtp({ mobile });
    const code = await lastSmsCode(`+91${mobile}`);
    expect(state.outbox).toHaveLength(0);
    await expect(verifyLoginOtp({ mobile, code })).rejects.toThrow(/Terms/);
    await requestLoginOtp({ mobile }).catch(() => undefined);
    const { user, isNewUser, channel } = await verifyLoginOtp({ mobile, code: await lastSmsCode(`+91${mobile}`), acceptedTerms: true });
    expect(isNewUser).toBe(true);
    expect(channel).toBe("SMS");
    expect(user.phoneE164).toBe(`+91${mobile}`);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(user.emailPlaceholder).toBe(true);
    expect(user.emailVerified).toBeNull();
    // Signing in again with the same number finds that account.
    await db.delete(loginOtps).where(eq(loginOtps.phoneE164, `+91${mobile}`));
    resetRateLimits();
    await requestLoginOtp({ mobile });
    const again = await verifyLoginOtp({ mobile, code: await lastSmsCode(`+91${mobile}`) });
    expect(again.user.id).toBe(user.id);
  });

  it("TC-SMSLOGIN-005 a new mobile number with SMS switched off: nothing is sent", async () => {
    await setRule("otp", { smsEnabled: false } as never, admin);
    const mobile = uniqueMobile();
    state.outbox = [];
    await requestLoginOtp({ mobile });
    await expect(lastSmsCode(`+91${mobile}`)).rejects.toThrow(/no SMS code/);
    expect(state.outbox).toHaveLength(0);
  });

  it("TC-SMSLOGIN-003 with SMS switched off (rule otp.smsEnabled) a verified mobile falls back to e-mail", async () => {
    const user = await verifiedCustomer();
    await setRule("otp", { smsEnabled: false } as never, admin);
    state.outbox = [];
    await requestLoginOtp({ mobile: user.phoneE164!.slice(3) });
    expect(lastEmailCode(user.email)).toMatch(/^\d{4,8}$/);
  });
});
