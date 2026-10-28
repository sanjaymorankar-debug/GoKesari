/**
 * Referral settings (docs/nearby-referral-2026-10, feature 2): referral code
 * Mandatory / Optional for customer and shop registration, stored in the
 * database, admin-only, logged, read live by every registration path.
 *
 * Covers: defaults (both OPTIONAL); only an admin can read or change them
 * (route and service); every change logged with who / old / new / when; all
 * four combinations of the two settings × blank / valid / invalid code for
 * shop registration (Add my shop, POST /api/shops), shop self-registration
 * (/shop/join, through payment and auto-approval) and customer registration
 * (code at first-time setup, first order); a change reaches new registrations
 * at once and never existing customers or shops.
 */
import { createHmac } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as adminGet, PUT as adminPut } from "@/app/api/admin/referral-settings/route";
import { POST as signupPost } from "@/app/api/me/signup-referral/route";
import { GET as publicGet } from "@/app/api/referral-settings/route";
import { POST as referralCheckRoute } from "@/app/api/shop-registrations/referral-check/route";
import { POST as shopRegisterRoute } from "@/app/api/shops/route";
import { POST as webhookRoute } from "@/app/api/webhooks/cashfree/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  outboundTestMessages,
  platformSettings,
  referralRedemptions,
  referralSettingChanges,
  registrationFeeTiers,
  shopCategories,
  shopRegistrations,
  shops,
  users,
  type ReferralRequirement,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { needsSignupReferralCode } from "@/server/services/customer-signup-referrals";
import { checkout } from "@/server/services/orders";
import { sendRegistrationOtp } from "@/server/registration/otp";
import { createRegistration, registrationStatus, startRegistrationPayment } from "@/server/registration/service";
import { createReferralCode } from "@/server/services/referrals";
import { getReferralSettings, setReferralSetting } from "@/server/services/referral-settings";
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

let admin = { id: "", email: "", name: null as string | null, role: "ADMIN" as const };
let categoryIds: string[] = [];
let counter = 0;

beforeAll(async () => {
  const rows = await db.select({ id: shopCategories.id }).from(shopCategories).limit(1);
  categoryIds = rows.map((r) => r.id);
});

beforeEach(async () => {
  await resetDatabase();
  await db.delete(outboundTestMessages);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["shopReferral", "customerSignupReferral", "selfRegistration"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await createReferralCode({ code: "GOOD-CODE-1", label: "Pune launch" }, admin);
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function setBoth(customer: ReferralRequirement, shop: ReferralRequirement) {
  await setReferralSetting("referral_required_customer", customer, admin);
  await setReferralSetting("referral_required_shop", shop, admin);
}

const COMBOS: [ReferralRequirement, ReferralRequirement][] = [
  ["OPTIONAL", "OPTIONAL"],
  ["OPTIONAL", "MANDATORY"],
  ["MANDATORY", "OPTIONAL"],
  ["MANDATORY", "MANDATORY"],
];

/* ------------------------------------------------------------ settings */

describe("referral settings are stored, admin-only and logged", () => {
  it("both start Optional; the public endpoint shows only the values", async () => {
    const settings = await getReferralSettings();
    expect(settings.referral_required_customer.value).toBe("OPTIONAL");
    expect(settings.referral_required_shop.value).toBe("OPTIONAL");
    const res = await call(publicGet, "/api/referral-settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customer: "OPTIONAL", shop: "OPTIONAL" });
  });

  it("an admin changes a setting; it is logged with who, old, new and when, and audited", async () => {
    signIn(admin, "ADMIN");
    const res = await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_shop", value: "MANDATORY" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ changed: true, setting: { key: "referral_required_shop", value: "MANDATORY" } });
    expect(res.body.lastChange).toMatchObject({ settingKey: "referral_required_shop", oldValue: "OPTIONAL", newValue: "MANDATORY", changedByEmail: admin.email, changedByRole: "ADMIN" });

    // The same value again changes and logs nothing.
    const again = await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_shop", value: "MANDATORY" } });
    expect(again.body.changed).toBe(false);

    const log = await db.select().from(referralSettingChanges);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ changedBy: admin.id, oldValue: "OPTIONAL", newValue: "MANDATORY" });
    expect(Math.abs(log[0].changedAt.getTime() - Date.now())).toBeLessThan(60_000);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "referral_setting.changed"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: admin.id, entityId: "referral_required_shop", previousValue: { value: "OPTIONAL" }, newValue: { value: "MANDATORY" } });

    const list = await call(adminGet, "/api/admin/referral-settings");
    expect(list.status).toBe(200);
    expect(list.body.settings.find((s: { key: string }) => s.key === "referral_required_shop").value).toBe("MANDATORY");
    expect(list.body.changes).toHaveLength(1);
    expect((await call(publicGet, "/api/referral-settings")).body).toEqual({ customer: "OPTIONAL", shop: "MANDATORY" });
  });

  it("operators, shop owners and customers can neither read nor change them; signed out is refused", async () => {
    for (const role of ["OPERATOR", "SHOP_OWNER", "CUSTOMER"] as const) {
      const user = await createUser({ role });
      signIn(user, role);
      expect((await call(adminGet, "/api/admin/referral-settings")).status).toBe(403);
      const put = await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_customer", value: "MANDATORY" } });
      expect(put.status).toBe(403);
      // The service refuses too, whatever route calls it.
      await expect(setReferralSetting("referral_required_customer", "MANDATORY", { id: user.id, role })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    state.session = null;
    expect((await call(adminGet, "/api/admin/referral-settings")).status).toBe(401);
    expect((await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_customer", value: "MANDATORY" } })).status).toBe(401);
    expect(await db.select().from(referralSettingChanges)).toHaveLength(0);
    expect((await getReferralSettings()).referral_required_customer.value).toBe("OPTIONAL");
  });

  it("refuses an unknown setting or value", async () => {
    signIn(admin, "ADMIN");
    expect((await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_rider", value: "MANDATORY" } })).status).toBe(422);
    expect((await call(adminPut, "/api/admin/referral-settings", { method: "PUT", body: { key: "referral_required_shop", value: "SOMETIMES" } })).status).toBe(422);
  });
});

/* ------------------------------------------------- shop: Add my shop */

function shopBody(extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Shree Dairy ${counter}`,
    ownerName: "Ramesh Patil",
    phone: "9876543210",
    addressLine1: "12 FC Road",
    city: "Pune",
    pincode: "411004",
    shopType: "DAIRY",
    annualTurnoverRupees: 1_500_000,
    categoryIds,
    shopActNumber: `PII/KOTHRUD/II/${20000 + counter}`,
    ...extra,
  };
}

describe("shop registration (Add my shop, POST /api/shops) follows referral_required_shop", () => {
  it.each(COMBOS)("customer %s / shop %s: blank, invalid and valid codes", async (customer, shop) => {
    await setBoth(customer, shop);
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const register = (body: Record<string, unknown>) => call(shopRegisterRoute, "/api/shops", { method: "POST", body });

    const blank = await register(shopBody({ referralCode: "" }));
    if (shop === "MANDATORY") {
      expect(blank.status).toBe(422);
      expect(blank.body.error.details.fields.referralCode).toContain("required");
    } else {
      expect(blank.status, JSON.stringify(blank.body)).toBe(201);
      expect(blank.body.referralCodeId ?? null).toBeNull();
    }

    const invalid = await register(shopBody({ referralCode: "NOPE-123" }));
    expect(invalid.status).toBe(422); // an entered code must be valid, optional or not
    expect(invalid.body.error.details.fields.referralCode).toContain("does not exist");

    // One registration under review per owner: the next shop comes from another account.
    signIn(await createUser(), "CUSTOMER");
    const valid = await register(shopBody({ referralCode: "good-code-1" }));
    expect(valid.status, JSON.stringify(valid.body)).toBe(201);
    const [row] = await db.select().from(shops).where(eq(shops.id, valid.body.id));
    expect(row.referralCodeId).not.toBeNull();
    expect(await db.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, row.id))).toHaveLength(1);
  });

  it("a change takes effect at once and leaves registered shops as they are", async () => {
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const first = await call(shopRegisterRoute, "/api/shops", { method: "POST", body: shopBody() });
    expect(first.status).toBe(201);
    await setReferralSetting("referral_required_shop", "MANDATORY", admin);
    expect((await call(shopRegisterRoute, "/api/shops", { method: "POST", body: shopBody() })).status).toBe(422);
    const [kept] = await db.select().from(shops).where(eq(shops.id, first.body.id));
    expect(kept.status).toBe("PENDING_APPROVAL");
    expect(kept.deletedAt).toBeNull();
    await setReferralSetting("referral_required_shop", "OPTIONAL", admin);
    signIn(await createUser(), "CUSTOMER"); // the first shop is still under review
    expect((await call(shopRegisterRoute, "/api/shops", { method: "POST", body: shopBody() })).status).toBe(201);
  });
});

/* ------------------------------------ shop: self-registration + auto-approval */

async function latestCode(mobileE164: string): Promise<string> {
  const rows = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, mobileE164));
  const last = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return /(\d{4,8})/.exec(last.body)![1];
}

async function selfRegister(referralCode: string | undefined) {
  const mobile = uniqueMobile();
  await sendRegistrationOtp(`+91${mobile}`, null);
  const otp = await latestCode(`+91${mobile}`);
  return createRegistration({ shopName: `Sai Kirana ${++counter}`, mobile, referralCode, tierCode: "BASIC", otp, acceptTerms: true }, "127.0.0.1");
}

function webhook(orderId: string) {
  const raw = JSON.stringify({
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: {
      order: { order_id: orderId, order_amount: 500, order_currency: "INR" },
      payment: { cf_payment_id: `cf${Date.now()}${counter}`, payment_status: "SUCCESS", payment_amount: 500, payment_currency: "INR" },
    },
  });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", process.env.CASHFREE_SECRET_KEY!).update(timestamp + raw).digest("base64");
  return webhookRoute(
    new NextRequest("http://localhost/api/webhooks/cashfree", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
    }),
  );
}

describe("shop self-registration (/shop/join) and auto-approval follow referral_required_shop", () => {
  beforeEach(async () => {
    await setRule("selfRegistration", { enabled: true, holdHours: 24, maxPendingPerMobile: 3, classification: "GREEN" }, admin);
    await db.insert(registrationFeeTiers).values({ code: "BASIC", label: "Basic", amountPaise: 50_000, isActive: true, sortOrder: 1 });
  });

  it.each(COMBOS)("customer %s / shop %s: blank, invalid and valid codes; payment approves", async (customer, shop) => {
    await setBoth(customer, shop);
    const check = (code: string) => call(referralCheckRoute, "/api/shop-registrations/referral-check", { method: "POST", body: { code } });

    // Blank
    const blankCheck = await check("");
    if (shop === "MANDATORY") {
      expect(blankCheck.body).toMatchObject({ ok: false, reason: "REQUIRED" });
      await expect(selfRegister("")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(selfRegister(undefined)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } else {
      expect(blankCheck.body).toMatchObject({ ok: true, code: null });
      expect(blankCheck.body.tiers).toHaveLength(1);
      const { token, registration } = await selfRegister("");
      expect(registration.referralCodeId).toBeNull();
      const pay = await startRegistrationPayment(token);
      expect((await webhook(pay.orderId)).status).toBe(200);
      const status = await registrationStatus(token);
      expect(status.status).toBe("APPROVED"); // auto-approved on payment, no code needed
      expect(status.referralCode).toBeNull();
      const [approved] = await db.select().from(shops).where(eq(shops.id, status.shop!.id));
      expect(approved).toMatchObject({ status: "APPROVED", referralCodeId: null, feePaymentStatus: "PAID" });
      expect(await db.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, approved.id))).toHaveLength(0);
    }

    // Invalid: refused either way.
    expect((await check("NOPE-123")).body).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    await expect(selfRegister("NOPE-123")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // Valid: registers; approval needs the payment as before.
    const { token } = await selfRegister("GOOD-CODE-1");
    expect((await registrationStatus(token)).status).toBe("PENDING_PAYMENT");
    const pay = await startRegistrationPayment(token);
    expect((await webhook(pay.orderId)).status).toBe(200);
    const status = await registrationStatus(token);
    expect(status).toMatchObject({ status: "APPROVED", referralCode: "GOOD-CODE-1" });
    expect(await db.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, status.shop!.id))).toHaveLength(1);
  });

  it("a registration made without a code is not charged once the code becomes mandatory", async () => {
    const { token, registration } = await selfRegister("");
    await setReferralSetting("referral_required_shop", "MANDATORY", admin);
    await expect(startRegistrationPayment(token)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [row] = await db.select().from(shopRegistrations).where(eq(shopRegistrations.id, registration.id));
    expect(row.status).toBe("PENDING_PAYMENT");
  });
});

/* ------------------------------------------------------------ customers */

async function shopWithMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  return createShopProduct(shop.id, product.id, { onlinePricePaise: 5_000, onlineStock: 50 });
}

async function tryCheckout(userId: string) {
  return checkout({ userId, addressId: await deliveryAddressId(userId), requestId: `r-${Math.random()}`, paymentMethod: "WALLET" });
}

describe("customer registration follows referral_required_customer", () => {
  it.each(COMBOS)("customer %s / shop %s: blank, invalid and valid codes", async (customer, shop) => {
    await setBoth(customer, shop);
    const sp = await shopWithMilk();
    const give = (code: string) => call(signupPost, "/api/me/signup-referral", { method: "POST", body: { code } });

    // Blank: a new customer's first order.
    const { user: blank } = await createUserWithWallet({ balancePaise: 50_000 });
    await addToCart(blank.id, sp.id, 1);
    if (customer === "MANDATORY") {
      expect(await needsSignupReferralCode(blank.id)).toBe(true);
      const refused = await tryCheckout(blank.id).catch((e) => e);
      expect(refused.code).toBe("CONFLICT");
      expect(refused.details).toMatchObject({ needsReferralCode: true });
    } else {
      expect(await needsSignupReferralCode(blank.id)).toBe(false);
      expect((await tryCheckout(blank.id)).orders).toHaveLength(1);
    }

    // Invalid: refused on the field either way, and does not count as given.
    const { user: wrong } = await createUserWithWallet({ balancePaise: 50_000 });
    signIn(wrong, "CUSTOMER");
    const invalid = await give("NOPE-123");
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details.fields.referralCode).toBe("This referral code is not valid.");
    expect(await needsSignupReferralCode(wrong.id)).toBe(customer === "MANDATORY");

    // Valid: accepted, then the first order goes through.
    const { user: valid } = await createUserWithWallet({ balancePaise: 50_000 });
    signIn(valid, "CUSTOMER");
    expect((await give("good-code-1")).status).toBe(200);
    expect(await needsSignupReferralCode(valid.id)).toBe(false);
    await addToCart(valid.id, sp.id, 1);
    expect((await tryCheckout(valid.id)).orders).toHaveLength(1);
  });

  it("switching to Mandatory never stops customers who joined before the switch; it applies to new ones at once", async () => {
    const { user: existing } = await createUserWithWallet({ balancePaise: 50_000 });
    await db.update(users).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(users.id, existing.id));
    await setReferralSetting("referral_required_customer", "MANDATORY", admin);
    expect(await needsSignupReferralCode(existing.id)).toBe(false);
    const { user: newcomer } = await createUserWithWallet({ balancePaise: 50_000 });
    expect(await needsSignupReferralCode(newcomer.id)).toBe(true);
    await setReferralSetting("referral_required_customer", "OPTIONAL", admin);
    expect(await needsSignupReferralCode(newcomer.id)).toBe(false);
  });
});
