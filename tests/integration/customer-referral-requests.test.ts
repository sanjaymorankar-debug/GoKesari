/**
 * Mandatory referral code for customers, and customers asking for one
 * (docs/four-features-2026-10, decided by the owner on 9 Oct 2026; rule
 * customerSignupReferral.required / requiredFrom / requestDuplicateWindowHours).
 *
 * A new customer can browse and search, but their first order (checkout or a
 * new subscription) needs a referral code. Without one they ask GoKesari with
 * their location, contact number, city and PIN code: saved, operations told,
 * the referrals team emailed. Operations issue a code (or decline); the
 * customer is told and enters it. Existing customers (joined before
 * requiredFrom, or already ordered), shop owners and staff are never stopped.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  emails: [] as { to: string; subject: string; text: string }[],
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.emails.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as adminList } from "@/app/api/admin/customer-referral-requests/route";
import { POST as adminDecide } from "@/app/api/admin/customer-referral-requests/[id]/route";
import { GET as myGet, POST as myPost } from "@/app/api/me/referral-request/route";
import { POST as signupPost } from "@/app/api/me/signup-referral/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { customerReferralRequests, notifications, platformSettings, referralCodes, users } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { needsSignupReferralCode } from "@/server/services/customer-signup-referrals";
import { checkout } from "@/server/services/orders";
import { createReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { activateSubscription, createSubscription } from "@/server/services/subscriptions";
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

let admin = { id: "", email: "", name: null as string | null };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["customerSignupReferral", "customerReferrals", "shopReferral"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  state.emails = [];
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name };
});

const asAdmin = { id: "", role: "ADMIN" as const };
async function requireCodes(extra: Record<string, unknown> = {}) {
  await setRule("customerSignupReferral", { enabled: true, required: true, ...extra }, { ...asAdmin, id: admin.id });
}

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole = "CUSTOMER") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function shopWithMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5_000, onlineStock: 50 });
  return { owner, shop, sp };
}

async function tryCheckout(userId: string) {
  return checkout({ userId, addressId: await deliveryAddressId(userId), requestId: `r-${Math.random()}`, paymentMethod: "WALLET" });
}

const request = (body: Record<string, unknown>) => call(myPost, "/api/me/referral-request", { method: "POST", body });
const VALID = { name: "Anil Patil", mobile: "9876543210", city: "Pune", pincode: "411001", latitude: 18.5204303, longitude: 73.8567437, accuracyM: 12.4 };

describe("mandatory referral code before a customer's first order", () => {
  it("off (default) or optional: checkout works without a code, as before", async () => {
    const { sp } = await shopWithMilk();
    const { user } = await createUserWithWallet({ balancePaise: 50_000 });
    await addToCart(user.id, sp.id, 1);
    expect(await needsSignupReferralCode(user.id)).toBe(false);
    await setRule("customerSignupReferral", { enabled: true }, { ...asAdmin, id: admin.id });
    expect(await needsSignupReferralCode(user.id)).toBe(false);
    expect((await tryCheckout(user.id)).orders).toHaveLength(1);
  });

  it("required: a new customer's first order is refused until they give a code; then it goes through", async () => {
    await requireCodes();
    await createReferralCode({ code: "PUNE-LAUNCH", label: "Pune launch" }, { ...asAdmin, id: admin.id });
    const { sp } = await shopWithMilk();
    const { user } = await createUserWithWallet({ balancePaise: 50_000 });
    await addToCart(user.id, sp.id, 1);

    const refused = await tryCheckout(user.id).catch((e) => e);
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("referral code");
    expect(refused.details).toMatchObject({ needsReferralCode: true });

    signIn(user);
    expect((await call(myGet, "/api/me/referral-request")).body).toMatchObject({ needsCode: true, referral: null, requests: [] });
    expect((await call(signupPost, "/api/me/signup-referral", { method: "POST", body: { code: "pune-launch" } })).status).toBe(200);
    expect((await call(myGet, "/api/me/referral-request")).body).toMatchObject({ needsCode: false, referral: { code: "PUNE-LAUNCH" } });
    expect((await tryCheckout(user.id)).orders).toHaveLength(1);
  });

  it("existing customers are never stopped: joined before requiredFrom, or already ordered; shop owners and staff are exempt", async () => {
    const { sp } = await shopWithMilk();
    const { user: before } = await createUserWithWallet({ balancePaise: 50_000 });
    await db.update(users).set({ createdAt: new Date("2026-10-01T10:00:00+05:30") }).where(eq(users.id, before.id));
    const { user: ordered } = await createUserWithWallet({ balancePaise: 50_000 });
    await addToCart(ordered.id, sp.id, 1);
    await tryCheckout(ordered.id);

    await requireCodes({ requiredFrom: "2026-10-09" });
    expect(await needsSignupReferralCode(before.id)).toBe(false);
    expect(await needsSignupReferralCode(ordered.id)).toBe(false);
    await addToCart(before.id, sp.id, 1);
    expect((await tryCheckout(before.id)).orders).toHaveLength(1);
    await addToCart(ordered.id, sp.id, 1);
    expect((await tryCheckout(ordered.id)).orders).toHaveLength(1);

    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    expect(await needsSignupReferralCode(owner.id)).toBe(false);
    expect(await needsSignupReferralCode(operator.id)).toBe(false);
    // Someone who joined today still needs one.
    expect(await needsSignupReferralCode((await createUser()).id)).toBe(true);
  });

  it("required: a new subscription (or activating a draft) needs a code too; a draft can be saved", async () => {
    await requireCodes();
    const { sp } = await shopWithMilk();
    const { user } = await createUserWithWallet({ balancePaise: 500_000 });
    const startDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const base = { userId: user.id, shopProductId: sp.id, quantityMilli: 1000, frequency: "DAILY" as const, startDate };
    const refused = await createSubscription(base).catch((e) => e);
    expect(refused.code).toBe("CONFLICT");
    const draft = await createSubscription({ ...base, draft: true });
    expect(draft.status).toBe("DRAFT");
    expect((await activateSubscription(draft.id, { id: user.id, role: "CUSTOMER" }).catch((e) => e)).code).toBe("CONFLICT");
  });
});

describe("a customer asks for a referral code", () => {
  it("checks the fields, saves the request with the location, tells operations and emails the referrals team", async () => {
    await requireCodes();
    await setRule("shopReferral", { notifyEmails: ["referrals@gokesari.com", "team@test.local"] }, { ...asAdmin, id: admin.id });
    const customer = await createUser({ name: "Anil Patil" });
    signIn(customer);

    const bad = await request({ name: "A", mobile: "12345", city: "", pincode: "011001" });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.details.fields).sort()).toEqual(["city", "mobile", "name", "pincode"]);

    const ok = await request(VALID);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ reference: expect.stringMatching(/^CRR-[0-9A-F]{8}$/), locationShared: true });
    expect(ok.body.mobileMasked).not.toContain("9876543210");

    const [row] = await db.select().from(customerReferralRequests);
    expect(row).toMatchObject({
      userId: customer.id,
      mobileE164: "+919876543210",
      city: "Pune",
      pincode: "411001",
      latitude: "18.52043",
      longitude: "73.856744",
      locationAccuracyM: 12,
      mapsUrl: "https://www.google.com/maps?q=18.52043,73.856744",
      locationStatus: "SHARED",
      status: "NEW",
      emailStatus: "SENT",
    });
    expect(state.emails.map((e) => e.to)).toEqual(["referrals@gokesari.com", "team@test.local"]);
    expect(state.emails[0].subject).toContain(ok.body.reference);
    expect(state.emails[0].text).toContain("Contact number: +919876543210");
    expect(state.emails[0].text).toContain("https://www.google.com/maps?q=18.52043,73.856744");
    expect(state.emails[0].text).toContain(customer.email);

    const support = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.customer_referral_request")));
    expect(support).toHaveLength(1);

    expect((await call(myGet, "/api/me/referral-request")).body.requests).toEqual([expect.objectContaining({ reference: ok.body.reference, status: "NEW" })]);
  });

  it("without a location it still goes, marked not shared; one request per customer or mobile within the window", async () => {
    await requireCodes();
    const customer = await createUser();
    signIn(customer);
    const first = await request({ ...VALID, latitude: null, longitude: null });
    expect(first.status).toBe(201);
    expect(first.body.locationShared).toBe(false);

    // The very same request moments later (a double tap, or the host repeating a POST after a 307)
    // is answered as the first one: same reference, no second email.
    const emailsBefore = state.emails.length;
    const repeat = await request({ ...VALID, latitude: null, longitude: null });
    expect(repeat.status).toBe(201);
    expect(repeat.body.reference).toBe(first.body.reference);
    expect(state.emails.length).toBe(emailsBefore);

    const again = await request({ ...VALID, mobile: "9123456780" });
    expect(again.status).toBe(429);
    expect(again.body.error.message).toContain(first.body.reference);

    // Someone else with the same number, too.
    resetRateLimits();
    signIn(await createUser());
    expect((await request(VALID)).status).toBe(429);
    expect(await db.select().from(customerReferralRequests)).toHaveLength(1);
  });

  it("refused when customer referral codes are switched off", async () => {
    const customer = await createUser();
    signIn(customer);
    expect((await request(VALID)).status).toBe(409);
  });
});

describe("operations answer a customer's request", () => {
  async function newRequest(mobile = VALID.mobile) {
    await requireCodes();
    const { user: customer } = await createUserWithWallet({ balancePaise: 50_000 });
    signIn(customer);
    const created = await request({ ...VALID, mobile });
    const [row] = await db.select().from(customerReferralRequests).where(eq(customerReferralRequests.userId, customer.id));
    return { customer, reference: created.body.reference as string, id: row.id };
  }

  it("only referral managers see and answer requests", async () => {
    const { id } = await newRequest();
    expect((await call(adminList, "/api/admin/customer-referral-requests")).status).toBe(403);
    expect((await call(adminDecide, "/x", { method: "POST", body: { action: "issue" }, params: { id } })).status).toBe(403);
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const list = await call(adminList, "/api/admin/customer-referral-requests?status=NEW");
    expect(list.status).toBe(200);
    expect(list.body.requests).toEqual([expect.objectContaining({ id, mobile: "+919876543210", locationStatus: "SHARED" })]);
  });

  it("issuing a code tells the customer, who enters it and can then order", async () => {
    const { customer, id, reference } = await newRequest();
    const { sp } = await shopWithMilk();
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const issued = await call(adminDecide, "/x", { method: "POST", body: { action: "issue", code: null, note: "Called, lives in Kothrud" }, params: { id } });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: "CODE_ISSUED", issuedCode: expect.stringMatching(/^GKC[A-Z2-9]{6}$/) });
    const code = issued.body.issuedCode as string;
    const [codeRow] = await db.select().from(referralCodes).where(eq(referralCodes.code, code));
    expect(codeRow.label).toBe(`Customer Anil Patil (${reference})`);

    const [note] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, customer.id), eq(notifications.type, "customer.referral_request_decided")));
    expect(note.body).toContain(code);

    // Answered once only.
    expect((await call(adminDecide, "/x", { method: "POST", body: { action: "reject", reason: "duplicate" }, params: { id } })).status).toBe(409);

    signIn(customer);
    expect((await call(myGet, "/api/me/referral-request")).body.requests[0]).toMatchObject({ status: "CODE_ISSUED", issuedCode: code });
    expect((await call(signupPost, "/api/me/signup-referral", { method: "POST", body: { code } })).status).toBe(200);
    await addToCart(customer.id, sp.id, 1);
    expect((await tryCheckout(customer.id)).orders).toHaveLength(1);
  });

  it("a typed code is used as given; declining needs a reason and tells the customer", async () => {
    const { customer, id } = await newRequest();
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    expect((await call(adminDecide, "/x", { method: "POST", body: { action: "reject", reason: "" }, params: { id } })).status).toBe(422);
    const rejected = await call(adminDecide, "/x", { method: "POST", body: { action: "reject", reason: "Outside our delivery area" }, params: { id } });
    expect(rejected.body).toMatchObject({ status: "REJECTED", decisionNote: "Outside our delivery area" });
    const [note] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, customer.id), eq(notifications.type, "customer.referral_request_decided")));
    expect(note.body).toContain("Outside our delivery area");

    const second = await newRequest("9123456780");
    signIn(operator, "OPERATOR");
    const typed = await call(adminDecide, "/x", { method: "POST", body: { action: "issue", code: "KOTHRUD-01" }, params: { id: second.id } });
    expect(typed.body.issuedCode).toBe("KOTHRUD-01");
  });

  it("re-sends the referrals email on request", async () => {
    const { id } = await newRequest();
    state.emails = [];
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const resent = await call(adminDecide, "/x", { method: "POST", body: { action: "resend_email" }, params: { id } });
    expect(resent.status).toBe(200);
    expect(state.emails).toHaveLength(1);
  });
});
