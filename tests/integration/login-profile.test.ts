/**
 * Login by mobile number or email (codes always emailed), first-time profile
 * details, My Profile edits, email change by code, checkout prerequisites and
 * the admin "release mobile number" action.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET as otpInfoRoute, POST as otpRequestRoute } from "@/app/api/otp/request/route";
import { PATCH as profilePatchRoute } from "@/app/api/profile/route";
import { POST as emailRequestRoute, PUT as emailConfirmRoute } from "@/app/api/profile/email/route";
import { POST as releasePhoneRoute } from "@/app/api/users/release-phone/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { loginOtps, users, wallets } from "@/server/db/schema";
import {
  EMAIL_IN_USE,
  MOBILE_IN_USE,
  OTP_INVALID,
  createLoginTicket,
  linkPhone,
  readLoginTicket,
  requestLoginOtp,
  verifyLoginOtp,
} from "@/server/otp/service";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { getProfile, nextOnboardingStep, updateProfile } from "@/server/services/profile";
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
} from "../helpers/fixtures";

beforeEach(async () => {
  state.outbox = [];
  state.session = null;
  resetRateLimits();
  await resetDatabase();
});

function lastCodeTo(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

/** Lets the same email request another code straight away (skips the resend cooldown). */
async function expireCooldown(email: string) {
  await db
    .update(loginOtps)
    .set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
    .where(eq(loginOtps.email, email));
}

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

describe("new user via mobile number", () => {
  it("asks for an email, sends the code there, and creates the account with the number and a wallet", async () => {
    expect(await requestLoginOtp({ mobile: "98765 43210" })).toEqual({ status: "EMAIL_REQUIRED" });
    expect(state.outbox).toHaveLength(0);

    const sent = await requestLoginOtp({ mobile: "9876543210", email: "Sanjay@Example.com" });
    expect(sent).toMatchObject({ status: "SENT", maskedEmail: "sa***@example.com" });

    const { user, isNewUser } = await verifyLoginOtp({
      mobile: "9876543210",
      email: "sanjay@example.com",
      code: lastCodeTo("sanjay@example.com"),
    });
    expect(isNewUser).toBe(true);
    expect(user.email).toBe("sanjay@example.com");
    expect(user.phoneE164).toBe("+919876543210");
    expect(user.phoneVerifiedAt).toBeNull();
    expect(user.emailVerified).not.toBeNull();
    expect(await db.query.wallets.findFirst({ where: eq(wallets.userId, user.id) })).toBeDefined();
    expect(nextOnboardingStep(await getProfile(user.id))).toBe("DETAILS");
  });

  it("next time, the registered number gets its code at the account's email, shown masked", async () => {
    const existing = await createUser({ email: "priya@gmail.com", mobile: "9123456789" });
    const sent = await requestLoginOtp({ mobile: "+91 91234 56789" });
    expect(sent).toMatchObject({ status: "SENT", maskedEmail: "pr***@gmail.com" });

    const { user, isNewUser } = await verifyLoginOtp({ mobile: "9123456789", code: lastCodeTo("priya@gmail.com") });
    expect(isNewUser).toBe(false);
    expect(user.id).toBe(existing.id);
  });

  it("links a new number to an existing email-only account instead of creating a second account", async () => {
    const existing = await createUser({ email: "old@example.com", mobile: null });
    await requestLoginOtp({ mobile: "9000000001", email: "old@example.com" });
    const { user, isNewUser } = await verifyLoginOtp({ mobile: "9000000001", email: "old@example.com", code: lastCodeTo("old@example.com") });
    expect(isNewUser).toBe(false);
    expect(user.id).toBe(existing.id);
    expect(user.phoneE164).toBe("+919000000001");
  });

  it("refuses an email that already belongs to an account with a different number", async () => {
    await createUser({ email: "taken@example.com", mobile: "9111111111" });
    await expect(requestLoginOtp({ mobile: "9222222222", email: "taken@example.com" })).rejects.toThrow(
      /already registered with a different mobile number/,
    );
  });
});

describe("new user via email", () => {
  it("creates the account on the first verified code, then asks for details and the mobile number", async () => {
    const sent = await requestLoginOtp({ email: "new@example.com" });
    expect(sent).toMatchObject({ status: "SENT", maskedEmail: "ne***@example.com" });
    const { user, isNewUser } = await verifyLoginOtp({ email: "new@example.com", code: lastCodeTo("new@example.com") });
    expect(isNewUser).toBe(true);
    expect(user.phoneE164).toBeNull();
    expect(nextOnboardingStep(await getProfile(user.id))).toBe("DETAILS");

    // "Save and continue" with no mobile: details done, the mobile popup comes next.
    await updateProfile(user.id, user.role, { name: "Asha", gender: "FEMALE", markComplete: true });
    const afterDetails = await getProfile(user.id);
    expect(afterDetails).toMatchObject({ name: "Asha", gender: "FEMALE" });
    expect(nextOnboardingStep(afterDetails)).toBe("MOBILE");

    await linkPhone(user.id, user.role, { mobile: "9333333333" });
    expect(nextOnboardingStep(await getProfile(user.id))).toBe("DONE");
  });
});

describe("existing email-only user", () => {
  it("signs in to the same account and is shown the details form until it is saved", async () => {
    const existing = await createUser({ email: "wallet-only@example.com", mobile: null, name: "" });
    await requestLoginOtp({ email: "wallet-only@example.com" });
    const { user, isNewUser } = await verifyLoginOtp({ email: "wallet-only@example.com", code: lastCodeTo("wallet-only@example.com") });
    expect(isNewUser).toBe(false);
    expect(user.id).toBe(existing.id);
    expect(nextOnboardingStep(await getProfile(user.id))).toBe("DETAILS");
  });
});

describe("skip and fill in later", () => {
  it("leaves the account usable and keeps prompting; checkout then asks for mobile and address", async () => {
    await requestLoginOtp({ email: "skipper@example.com" });
    const { user } = await verifyLoginOtp({ email: "skipper@example.com", code: lastCodeTo("skipper@example.com") });
    // "Fill in later" saves nothing: still prompted on the next sign-in.
    expect(nextOnboardingStep(await getProfile(user.id))).toBe("DETAILS");

    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const product = await createProduct((await createCategory({ department: "DAIRY" })).id);
    const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5000, onlineStock: 10 });
    await db.update(wallets).set({ balancePaise: 100_000 }).where(eq(wallets.userId, user.id));
    await addToCart(user.id, shopProduct.id, 1);

    await expect(checkout({ userId: user.id, requestId: "skip-req-1" })).rejects.toThrow(/Add your mobile number/);
    await linkPhone(user.id, user.role, { mobile: "9444444444" });
    await expect(checkout({ userId: user.id, requestId: "skip-req-2" })).rejects.toThrow(/Add a delivery address/);
    const { orders } = await checkout({ userId: user.id, requestId: "skip-req-3", addressId: await deliveryAddressId(user.id) });
    expect(orders).toHaveLength(1);
  });

  it("a shop that only offers pickup needs no address", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { deliveryAvailable: false });
    const product = await createProduct((await createCategory({ department: "DAIRY" })).id);
    const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5000, onlineStock: 10 });
    await addToCart(user.id, shopProduct.id, 1);
    const { orders } = await checkout({ userId: user.id, requestId: "pickup-req-1" });
    expect(orders[0].addressId).toBeNull();
  });
});

describe("profile edit", () => {
  it("updates name, gender and mobile through PATCH /api/profile", async () => {
    const user = await createUser({ name: "Old", mobile: null });
    signInAs(user);
    const r = await call(profilePatchRoute, "/api/profile", {
      method: "PATCH",
      body: { name: "  New Name ", gender: "OTHER", mobile: "8888888888" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "New Name", gender: "OTHER", phoneE164: "+918888888888" });
  });

  it("rejects an invalid Indian mobile number and an unknown gender", async () => {
    const user = await createUser({ mobile: null });
    signInAs(user);
    for (const mobile of ["12345", "5876543210", "98765432100"]) {
      const r = await call(profilePatchRoute, "/api/profile", { method: "PATCH", body: { mobile } });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/10-digit Indian mobile/);
    }
    const g = await call(profilePatchRoute, "/api/profile", { method: "PATCH", body: { gender: "UNKNOWN" } });
    expect(g.status).toBe(422);
  });

  it("changes the email only after a code sent to the new address is entered", async () => {
    const user = await createUser({ email: "before@example.com" });
    signInAs(user);

    const sent = await call(emailRequestRoute, "/api/profile/email", { method: "POST", body: { email: "after@example.com" } });
    expect(sent.status).toBe(200);
    expect(sent.body.maskedEmail).toBe("af***@example.com");
    expect((await db.query.users.findFirst({ where: eq(users.id, user.id) }))!.email).toBe("before@example.com");

    const wrong = await call(emailConfirmRoute, "/api/profile/email", {
      method: "PUT",
      body: { email: "after@example.com", code: "000000" === lastCodeTo("after@example.com") ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(422);

    const ok = await call(emailConfirmRoute, "/api/profile/email", {
      method: "PUT",
      body: { email: "after@example.com", code: lastCodeTo("after@example.com") },
    });
    expect(ok.status).toBe(200);
    expect((await db.query.users.findFirst({ where: eq(users.id, user.id) }))!.email).toBe("after@example.com");
    // The old inbox is told about the change.
    expect(state.outbox.some((m) => m.to === "before@example.com" && /was changed/.test(m.subject))).toBe(true);
  });

  it("a login code cannot be used to confirm an email change", async () => {
    const user = await createUser({ email: "me@example.com" });
    signInAs(user);
    await requestLoginOtp({ email: "spare@example.com" });
    const r = await call(emailConfirmRoute, "/api/profile/email", {
      method: "PUT",
      body: { email: "spare@example.com", code: lastCodeTo("spare@example.com") },
    });
    expect(r.status).toBe(422);
  });
});

describe("duplicate mobile or email", () => {
  it("refuses a mobile number already on another account", async () => {
    await createUser({ mobile: "9555555555" });
    const other = await createUser({ mobile: null });
    await expect(updateProfile(other.id, other.role, { mobile: "9555555555" })).rejects.toThrow(MOBILE_IN_USE);
    await expect(linkPhone(other.id, other.role, { mobile: "9555555555" })).rejects.toThrow(MOBILE_IN_USE);
  });

  it("refuses an email change to an address another account uses", async () => {
    await createUser({ email: "someone@example.com" });
    const me = await createUser({ email: "me2@example.com" });
    signInAs(me);
    const r = await call(emailRequestRoute, "/api/profile/email", { method: "POST", body: { email: "Someone@Example.com" } });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe(EMAIL_IN_USE);
  });

  it("an admin can release a wrongly claimed number so its owner can add it", async () => {
    const squatter = await createUser({ email: "squatter@example.com", mobile: "9666666666" });
    const owner = await createUser({ mobile: null });
    const admin = await createUser({ role: "ADMIN" });

    signInAs(owner);
    expect((await call(releasePhoneRoute, "/api/users/release-phone", { method: "POST", body: { mobile: "9666666666", reason: "owner proved it" } })).status).toBe(403);

    signInAs(admin);
    const r = await call(releasePhoneRoute, "/api/users/release-phone", {
      method: "POST",
      body: { mobile: "9666666666", reason: "owner proved it" },
    });
    expect(r.status).toBe(200);
    expect(r.body.userId).toBe(squatter.id);
    await linkPhone(owner.id, owner.role, { mobile: "9666666666" });
    expect((await getProfile(owner.id)).phoneE164).toBe("+919666666666");
  });
});

describe("wrong or expired code", () => {
  it("rejects a wrong code, and locks the code after the attempt limit even for the right digits", async () => {
    await requestLoginOtp({ email: "guess@example.com" });
    const code = lastCodeTo("guess@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(verifyLoginOtp({ email: "guess@example.com", code: wrong })).rejects.toThrow(OTP_INVALID);
    }
    await expect(verifyLoginOtp({ email: "guess@example.com", code })).rejects.toThrow(/Too many wrong attempts/);
  });

  it("rejects an expired code", async () => {
    await requestLoginOtp({ email: "late@example.com" });
    await db.update(loginOtps).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginOtps.email, "late@example.com"));
    await expect(verifyLoginOtp({ email: "late@example.com", code: lastCodeTo("late@example.com") })).rejects.toThrow(OTP_INVALID);
  });

  it("a code works once, and a newer code replaces the older one", async () => {
    await requestLoginOtp({ email: "once@example.com" });
    const first = lastCodeTo("once@example.com");
    await expireCooldown("once@example.com");
    await requestLoginOtp({ email: "once@example.com" });
    const second = lastCodeTo("once@example.com");
    if (first !== second) {
      await expect(verifyLoginOtp({ email: "once@example.com", code: first })).rejects.toThrow(OTP_INVALID);
    }
    await verifyLoginOtp({ email: "once@example.com", code: second });
    await expect(verifyLoginOtp({ email: "once@example.com", code: second })).rejects.toThrow(OTP_INVALID);
  });

  it("a code requested for one mobile number cannot sign in with another", async () => {
    await createUser({ email: "a@example.com", mobile: "9777777777" });
    await requestLoginOtp({ mobile: "9777777777" });
    await expect(
      verifyLoginOtp({ mobile: "9888888881", email: "a@example.com", code: lastCodeTo("a@example.com") }),
    ).rejects.toThrow(OTP_INVALID);
  });

  it("rate-limits repeat requests for the same email", async () => {
    await requestLoginOtp({ email: "spam@example.com" });
    await expect(requestLoginOtp({ email: "spam@example.com" })).rejects.toThrow(/Please wait \d+ seconds/);
  });

  it("refuses a suspended account", async () => {
    const user = await createUser({ email: "bad@example.com", mobile: "9999900000" });
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, user.id));
    await expect(requestLoginOtp({ mobile: "9999900000" })).rejects.toThrow(/suspended or closed/);
    await expect(requestLoginOtp({ email: "bad@example.com" })).rejects.toThrow(/suspended or closed/);
  });
});

describe("POST /api/otp/request", () => {
  it("validates input and reports which step comes next", async () => {
    expect((await call(otpRequestRoute, "/api/otp/request", { method: "POST", body: {} })).status).toBe(422);
    const badMobile = await call(otpRequestRoute, "/api/otp/request", { method: "POST", body: { mobile: "12345" } });
    expect(badMobile.status).toBe(422);
    const badEmail = await call(otpRequestRoute, "/api/otp/request", { method: "POST", body: { email: "not-an-email" } });
    expect(badEmail.status).toBe(422);

    const unknown = await call(otpRequestRoute, "/api/otp/request", { method: "POST", body: { mobile: "9812345678" } });
    expect(unknown.body).toEqual({ status: "EMAIL_REQUIRED" });

    const info = await call(otpInfoRoute, "/api/otp/request");
    expect(info.body).toMatchObject({ email: true, codeLength: 6 });
  });
});

describe("login ticket", () => {
  it("round-trips, and rejects tampering", () => {
    const ticket = createLoginTicket("8a1c2f8e-0000-4000-8000-000000000001");
    expect(readLoginTicket(ticket)).toBe("8a1c2f8e-0000-4000-8000-000000000001");
    const [id, expires, mac] = ticket.split(".");
    expect(readLoginTicket(`${id}.${Number(expires) + 60_000}.${mac}`)).toBeNull();
    expect(readLoginTicket(`8a1c2f8e-0000-4000-8000-000000000002.${expires}.${mac}`)).toBeNull();
    expect(readLoginTicket("garbage")).toBeNull();
  });
});
