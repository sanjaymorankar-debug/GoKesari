/**
 * docs/onboarding-v2-2026-11, Flow 1 — the customer signs in only at checkout (flag onboarding_v2), against real
 * PostgreSQL: flag off unchanged; guest cart → login sheet (Terms tick with version + time, e-mail, mobile code)
 * → account + wallet → order COD / ONLINE (sandbox gateway) without an address → delivery location after payment;
 * rider dispatch held until then; pickup needs no address; a returning customer skips the sheet; the no-SMS
 * fallback rule both ways. SMS_PROVIDER=mock in tests: codes are read from outbound_test_messages.
 */
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
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

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void state.cookies.set(name, value),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as previewRoute } from "@/app/api/cart/preview/route";
import { POST as checkoutRoute } from "@/app/api/checkout/route";
import { POST as consentRoute } from "@/app/api/onboarding-v2/customer/consent/route";
import { POST as mobileRoute } from "@/app/api/onboarding-v2/customer/mobile/route";
import { POST as statusRoute } from "@/app/api/onboarding-v2/customer/status/route";
import { POST as deliveryLocationRoute } from "@/app/api/onboarding-v2/orders/delivery-location/route";
import { GET as referralLinkRoute } from "@/app/r/[code]/route";
import { POST as webhookRoute } from "@/app/api/webhooks/payments/[gateway]/route";
import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { LOCATION_COOKIE } from "@/lib/location";
import { PATCH as orderStatusRoute } from "@/app/api/orders/[id]/status/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  notifications,
  outboundTestMessages,
  paymentIntents,
  policyAcceptances,
  shops,
  userConsents,
  users,
  wallets,
  orders,
  type User,
} from "@/server/db/schema";
import { getGatewayByName } from "@/server/payments/gateway/registry";
import type { SandboxGateway } from "@/server/payments/gateway/sandbox";
import {
  ADDRESS_PENDING_TIMEOUT_REASON,
  cancelStaleAddressPendingOrders,
  customerLoginStatus,
  firstCheckoutOrderIds,
  NO_SMS_BLOCKED,
  V2_TERMS_COOKIE,
} from "@/server/onboarding-v2/customer";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { listCurrentVersions } from "@/server/services/policy-versions";
import { requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { addToCart } from "@/server/services/cart";
import { getOrCreateReferralCode } from "@/server/services/customer-referrals";
import { assignNearestPartner, dispatchReadyOrder } from "@/server/services/delivery-assignment";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  resetDatabase,
  uniqueMobile,
} from "../helpers/fixtures";

const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
let admin: User;
let seq = 0;

beforeEach(async () => {
  state.outbox = [];
  state.session = null;
  // The location chosen in the header (PIN 411001, where the fixture shops are): checked before payment.
  state.cookies.clear();
  setLocation("411001");
  resetRateLimits();
  await resetDatabase();
  clearRuleCache();
  clearFeatureFlagCache();
  admin = await createUser({ role: "ADMIN" });
  // Address verification calls Google; never in tests.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setLocation(pincode: string | null) {
  if (!pincode) state.cookies.delete(LOCATION_COOKIE);
  else
    state.cookies.set(
      LOCATION_COOKIE,
      JSON.stringify({ label: `PIN ${pincode}`, pincode, latitude: null, longitude: null, source: "PINCODE", addressId: null, societyId: null }),
    );
}

const adminActor = () => ({ id: admin.id, role: "ADMIN" as const });

async function v2On() {
  await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "onboarding v2 customer test", adminActor());
  clearFeatureFlagCache();
}

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function shopWithMilk(options: { deliveryAvailable?: boolean } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: `Dairy ${++seq}`, deliveryAvailable: options.deliveryAvailable ?? true, deliveryFeePaise: 2_000 });
  const listing = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7_000, onlineStock: 20 });
  await db.update(shops).set({ codEnabled: true }).where(eq(shops.id, shop.id));
  return { owner, shop, listing };
}

function lastEmailCode(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
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
  if (!code) throw new Error("no SMS code was sent");
  return code;
}

/** POST a route with an optional cookie header, returning status, body and the Set-Cookie header. */
async function post(handler: (r: NextRequest) => Promise<Response>, path: string, body: unknown, cookie?: string) {
  const request = new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 test", ...(cookie ? { cookie } : {}) },
  });
  const response = await handler(request);
  return { status: response.status, body: await response.json().catch(() => null), setCookie: response.headers.get("set-cookie") };
}

/**
 * Steps 1–3 as a guest goes through them: the Terms tick (cookie), the e-mail verified with the e-mailed code
 * (as the sheet does in the app), the status call that writes the tick, and the mobile code.
 */
async function guestThroughSheet(email = `guest-${++seq}@test.local`) {
  state.session = null;
  const consent = await post(consentRoute as never, "/api/onboarding-v2/customer/consent", { accepted: true });
  expect(consent.status).toBe(200);
  expect(consent.body).toMatchObject({ version: CURRENT_POLICY_VERSION, recorded: false });
  expect(consent.body.acceptedAtIst).toMatch(/IST$/);
  const cookie = consent.setCookie!.split(";")[0];
  expect(cookie.startsWith(`${V2_TERMS_COOKIE}=`)).toBe(true);

  await requestLoginOtp({ email });
  const { user, isNewUser } = await verifyLoginOtp({ email, code: lastEmailCode(email), acceptedTerms: true });
  expect(isNewUser).toBe(true);
  signInAs(user);

  const status = await post(statusRoute as never, "/api/onboarding-v2/customer/status", {}, cookie);
  expect(status.status).toBe(200);
  expect(status.body.step).toBe("MOBILE");

  const mobile = uniqueMobile();
  const sent = await call(mobileRoute as never, "/api/onboarding-v2/customer/mobile", { method: "POST", body: { action: "send", mobile } });
  expect(sent.status).toBe(200);
  expect(sent.body.status).toBe("CODE_SENT");
  const verified = await call(mobileRoute as never, "/api/onboarding-v2/customer/mobile", {
    method: "POST",
    body: { action: "verify", mobile, code: await lastSmsCode(`+91${mobile}`) },
  });
  expect(verified.status).toBe(200);
  expect(verified.body.step).toBe("DONE");
  const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
  return { user: fresh, consentCookie: cookie };
}

async function placeViaRoute(body: Record<string, unknown>) {
  return call(checkoutRoute as never, "/api/checkout", { method: "POST", body: { requestId: `req-ov2-${++seq}`, orderType: "PERSONAL", ...body } });
}

/** Owner 27-Nov-2026: cash on delivery never waits for an address, so the "address later" orders here are paid from the wallet. */
async function fundWallet(userId: string) {
  await db.update(wallets).set({ balancePaise: 100_000 }).where(eq(wallets.userId, userId));
}

const NEW_ADDRESS = { line1: "12 MG Road", area: "Camp", city: "Pune", pincode: "411001", latitude: 18.52, longitude: 73.87 };

/* ------------------------------------------------------------------ flag off */

describe("flag onboarding_v2 off — unchanged", () => {
  it("TC-OV2C-001 checkout still needs an address; addressAfterPayment is ignored; v2 routes answer 404", async () => {
    const { listing } = await shopWithMilk();
    const customer = await createUser();
    await addToCart(customer.id, listing.id, 1);
    await expect(checkout({ userId: customer.id, requestId: "req-off-1", paymentMethod: "COD", addressAfterPayment: true })).rejects.toThrow(
      /delivery address/i,
    );
    signInAs(customer);
    const viaRoute = await placeViaRoute({ paymentMethod: "COD" });
    expect(viaRoute.status).toBe(422);
    expect(await db.select().from(orders)).toHaveLength(0);

    expect((await post(consentRoute as never, "/api/onboarding-v2/customer/consent", { accepted: true })).status).toBe(404);
    expect((await post(statusRoute as never, "/api/onboarding-v2/customer/status", {})).status).toBe(404);
    // guest_cart_enabled off too: the guest preview stays closed.
    expect((await call(previewRoute as never, "/api/cart/preview", { method: "POST", body: { lines: [] } })).status).toBe(404);
  });

  it("TC-OV2C-002 a guest's referral link still goes to sign-in", async () => {
    const referrer = await createUser();
    const code = await getOrCreateReferralCode(referrer.id);
    const response = await referralLinkRoute(new NextRequest(`http://localhost/r/${code}`), { params: Promise.resolve({ code }) });
    expect(response.headers.get("location")).toBe("/signin");
  });
});

/* ------------------------------------------------------------------- flag on */

describe("flag onboarding_v2 on — guest mode", () => {
  it("TC-OV2C-003 the guest cart works without guest_cart_enabled", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const res = await call(previewRoute as never, "/api/cart/preview", { method: "POST", body: { lines: [{ shopProductId: listing.id, quantity: 2 }] } });
    expect(res.status).toBe(200);
    expect(res.body.subtotalPaise).toBe(14_000);
    expect(res.body.groups[0].deliveryFeePaise).toBe(2_000);
  });

  it("TC-OV2C-004 a guest's referral link opens the home page (code remembered); shop referral codes still open Add my shop", async () => {
    await v2On();
    const referrer = await createUser();
    const code = await getOrCreateReferralCode(referrer.id);
    const response = await referralLinkRoute(new NextRequest(`http://localhost/r/${code}`), { params: Promise.resolve({ code }) });
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(code);
  });
});

describe("flag onboarding_v2 on — login sheet", () => {
  it("TC-OV2C-010 guest → Terms tick (version + time) → e-mail → mobile code → account + wallet", async () => {
    await v2On();
    const { user } = await guestThroughSheet();
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.emailVerified).not.toBeNull();
    expect(await db.select().from(wallets).where(eq(wallets.userId, user.id))).toHaveLength(1);

    const consents = await db.select().from(userConsents).where(eq(userConsents.userId, user.id));
    const sheet = consents.find((c) => c.source === "CHECKOUT_LOGIN_SHEET");
    expect(sheet).toMatchObject({ consentType: "TERMS_AND_PRIVACY", version: CURRENT_POLICY_VERSION, granted: true });
    expect(Date.now() - sheet!.createdAt.getTime()).toBeLessThan(60_000);
    const accepted = await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, user.id));
    expect(accepted.map((a) => a.doc).sort()).toEqual(["privacy-policy", "terms"]);
    // The published version of each document (Admin → Policy versions), else the site's CURRENT_POLICY_VERSION.
    const published = await listCurrentVersions();
    for (const a of accepted) {
      expect(a.channel).toBe("WEB");
      expect(a.version).toBe(published.find((c) => c.doc === a.doc)?.latest?.version ?? CURRENT_POLICY_VERSION);
    }

    const status = await customerLoginStatus(user.id);
    expect(status.step).toBe("DONE");
    expect(status.consent?.acceptedAtIst).toMatch(/IST$/);
  });

  it("TC-OV2C-011 a returning customer (Terms, e-mail and mobile done) skips the sheet", async () => {
    await v2On();
    const returning = await createUser();
    await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, returning.id));
    await db.insert(userConsents).values({ userId: returning.id, consentType: "TERMS_AND_PRIVACY", version: "2026-08-21" });
    signInAs(returning);
    const status = await post(statusRoute as never, "/api/onboarding-v2/customer/status", {});
    expect(status.body.step).toBe("DONE");
  });

  it("TC-OV2C-012 checkout is refused until the sheet is finished, and needs a payment method chosen", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const half = await createUser();
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, half.id));
    await db.insert(userConsents).values({ userId: half.id, consentType: "TERMS_AND_PRIVACY", version: CURRENT_POLICY_VERSION });
    await addToCart(half.id, listing.id, 1);
    signInAs(half);
    const refused = await placeViaRoute({ paymentMethod: "COD" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ loginSheet: true, step: "MOBILE" });

    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, half.id));
    const noMethod = await placeViaRoute({});
    expect(noMethod.status).toBe(422);
    expect(noMethod.body.error.message).toMatch(/Choose how to pay/);
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("TC-OV2C-013 no SMS + fallback rule on: the mobile is saved unverified and the sheet finishes", async () => {
    await v2On();
    await setRule("otp", { smsEnabled: false }, adminActor());
    const user = await createUser({ mobile: null });
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    await db.insert(userConsents).values({ userId: user.id, consentType: "TERMS_AND_PRIVACY", version: CURRENT_POLICY_VERSION });
    signInAs(user);
    const mobile = uniqueMobile();
    const saved = await call(mobileRoute as never, "/api/onboarding-v2/customer/mobile", { method: "POST", body: { action: "send", mobile } });
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe("SAVED_UNVERIFIED");
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.phoneE164).toBe(`+91${mobile}`);
    expect(row.phoneVerifiedAt).toBeNull();
    expect((await customerLoginStatus(user.id)).step).toBe("DONE");
    expect(await db.select().from(wallets).where(eq(wallets.userId, user.id))).toHaveLength(1);
  });

  it("TC-OV2C-014 no SMS + fallback rule off: blocked with a clear message", async () => {
    await v2On();
    await setRule("otp", { smsEnabled: false }, adminActor());
    await setRule("onboardingV2", { mobileOtpFallbackWhenNoSms: false }, adminActor());
    const user = await createUser({ mobile: null });
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    await db.insert(userConsents).values({ userId: user.id, consentType: "TERMS_AND_PRIVACY", version: CURRENT_POLICY_VERSION });
    signInAs(user);
    const refused = await call(mobileRoute as never, "/api/onboarding-v2/customer/mobile", { method: "POST", body: { action: "send", mobile: uniqueMobile() } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(NO_SMS_BLOCKED);
    const status = await customerLoginStatus(user.id);
    expect(status).toMatchObject({ step: "MOBILE", blockedReason: NO_SMS_BLOCKED });
  });
});

describe("flag onboarding_v2 on — order, then the delivery location", () => {
  it("TC-OV2C-020 wallet without an address: shop gets the order, no rider until the location is set", async () => {
    await v2On();
    const { listing, shop } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 2);
    await fundWallet(user.id);
    const placed = await placeViaRoute({ paymentMethod: "WALLET" });
    expect(placed.status).toBe(201);
    expect(placed.body.orders).toHaveLength(1);
    expect(placed.body.orders[0]).toMatchObject({ paymentMethod: "WALLET", status: "CONFIRMED", addressPending: true, totalPaise: 16_000 });
    const orderId = placed.body.orders[0].id as string;
    let [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order.shopId).toBe(shop.id);
    expect(order.addressId).toBeNull();
    expect(order.addressPendingSince).not.toBeNull();

    // The shop marks it ready: still no rider while the customer has not given the location.
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, orderId));
    expect(await dispatchReadyOrder(orderId, { id: null, role: null })).toBeNull();
    await expect(assignNearestPartner(orderId, { id: null, role: null })).rejects.toThrow(/waiting for the customer's delivery location/);
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, orderId))).toHaveLength(0);

    // Somebody else cannot set it.
    const stranger = await createUser();
    signInAs(stranger);
    expect((await call(deliveryLocationRoute as never, "/api/onboarding-v2/orders/delivery-location", { method: "POST", body: { orderIds: [orderId], address: NEW_ADDRESS } })).status).toBe(403);

    signInAs(user);
    const set = await call(deliveryLocationRoute as never, "/api/onboarding-v2/orders/delivery-location", {
      method: "POST",
      body: { orderIds: [orderId], address: NEW_ADDRESS, saveAddress: true, name: "Asha", referralCode: "NOSUCHCODE1" },
    });
    expect(set.status).toBe(200);
    expect(set.body.referral).toMatchObject({ applied: false });
    [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order.addressPendingSince).toBeNull();
    expect(order.addressId).toBe(set.body.addressId);
    expect(order.deliveryAddressSnapshot).toMatchObject({ line1: "12 MG Road", pincode: "411001", latitude: "18.52", longitude: "73.87" });
    const [saved] = await db.select().from(addresses).where(eq(addresses.id, set.body.addressId));
    expect(saved.deletedAt).toBeNull();
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].name).toBe("Asha");

    // Only while it waits.
    expect((await call(deliveryLocationRoute as never, "/api/onboarding-v2/orders/delivery-location", { method: "POST", body: { orderIds: [orderId], address: NEW_ADDRESS } })).status).toBe(409);
  });

  it("TC-OV2C-021 ONLINE (sandbox gateway) without an address: paid, then the location", async () => {
    await v2On();
    await setRule("onlinePayments", { enabled: true }, adminActor());
    const { listing } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    const placed = await placeViaRoute({ paymentMethod: "ONLINE" });
    expect(placed.status).toBe(201);
    expect(placed.body.orders[0]).toMatchObject({ paymentMethod: "ONLINE", status: "PENDING", addressPending: true });
    expect(placed.body.payment.intentId).toBeTruthy();

    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, placed.body.payment.intentId));
    const webhook = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
    const response = await webhookRoute(new NextRequest("http://localhost/api/webhooks/payments/sandbox", { method: "POST", body: webhook.rawBody, headers: webhook.headers }), {
      params: Promise.resolve({ gateway: "sandbox" }),
    });
    expect(response.status).toBe(200);
    const orderId = placed.body.orders[0].id as string;
    let [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order.status).toBe("CONFIRMED");
    expect(order.paidAt).not.toBeNull();
    expect(order.addressPendingSince).not.toBeNull();

    // Not saved to "My addresses": the row stays for the order, hidden from the list.
    const set = await call(deliveryLocationRoute as never, "/api/onboarding-v2/orders/delivery-location", {
      method: "POST",
      body: { orderIds: [orderId], address: NEW_ADDRESS, saveAddress: false },
    });
    expect(set.status).toBe(200);
    [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order.addressPendingSince).toBeNull();
    expect(order.deliveryAddressSnapshot?.pincode).toBe("411001");
    const [hidden] = await db.select().from(addresses).where(eq(addresses.id, set.body.addressId));
    expect(hidden.deletedAt).not.toBeNull();
  });

  it("TC-OV2C-022 a location the shop does not deliver to is refused; the order keeps waiting", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    await fundWallet(user.id);
    const placed = await placeViaRoute({ paymentMethod: "WALLET" });
    const orderId = placed.body.orders[0].id as string;
    const far = await call(deliveryLocationRoute as never, "/api/onboarding-v2/orders/delivery-location", {
      method: "POST",
      body: { orderIds: [orderId], address: { ...NEW_ADDRESS, pincode: "400001", city: "Mumbai" } },
    });
    expect(far.status).toBe(409);
    expect(far.body.error.message).toMatch(/does not deliver/);
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0].addressPendingSince).not.toBeNull();
    expect(await db.select().from(addresses).where(eq(addresses.userId, user.id))).toHaveLength(0);
  });

  it("TC-OV2C-023 pickup (a shop that does not deliver) needs no address and never waits", async () => {
    await v2On();
    const { listing } = await shopWithMilk({ deliveryAvailable: false });
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    await db.update(wallets).set({ balancePaise: 100_000 }).where(eq(wallets.userId, user.id));
    const again = await placeViaRoute({ paymentMethod: "WALLET" });
    expect(again.status).toBe(201);
    const [order] = await db.select().from(orders).where(eq(orders.id, again.body.orders[0].id));
    expect(order.addressId).toBeNull();
    expect(order.addressPendingSince).toBeNull();
    expect(again.body.orders[0].addressPending).toBeUndefined();
  });

  it("TC-OV2C-024 a saved address chosen before paying is used as before (nothing waits)", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    const [address] = await db.insert(addresses).values({ userId: user.id, line1: "2 Test Lane", city: "Pune", pincode: "411001", isDefault: true, addressType: "HOME" }).returning();
    await addToCart(user.id, listing.id, 1);
    const placed = await placeViaRoute({ paymentMethod: "COD", addressId: address.id });
    expect(placed.status).toBe(201);
    const [order] = await db.select().from(orders).where(eq(orders.id, placed.body.orders[0].id));
    expect(order.addressId).toBe(address.id);
    expect(order.addressPendingSince).toBeNull();
  });

  it("TC-OV2C-025 cash on delivery needs a delivery address or the customer's pickup from the shop (owner 27-Nov-2026)", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    const refused = await placeViaRoute({ paymentMethod: "COD" });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/delivery address, or pick the order up from the shop/);
    expect(await db.select().from(orders)).toHaveLength(0);
    // pickupAtShop only counts with cash on delivery; a wallet order still waits for its address as before.
    const pickup = await placeViaRoute({ paymentMethod: "COD", pickupAtShop: true });
    expect(pickup.status).toBe(201);
    expect(pickup.body.orders[0].addressPending).toBeUndefined();
    const [order] = await db.select().from(orders).where(eq(orders.id, pickup.body.orders[0].id));
    expect(order).toMatchObject({ paymentMethod: "COD", addressId: null, addressPendingSince: null });
  });
});

describe("flag onboarding_v2 on — money safety for orders placed before the address", () => {
  async function pendingOrder(paymentMethod: "WALLET" | "ONLINE" = "WALLET") {
    const { listing, owner } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    if (paymentMethod === "WALLET") await fundWallet(user.id);
    const placed = await placeViaRoute({ paymentMethod });
    expect(placed.status).toBe(201);
    return { user, owner, placed, orderId: placed.body.orders[0].id as string };
  }

  it("TC-OV2C-030 checkout is refused when no location is known or the shop does not deliver there", async () => {
    await v2On();
    const { listing } = await shopWithMilk();
    const { user } = await guestThroughSheet();
    await addToCart(user.id, listing.id, 1);
    await fundWallet(user.id);
    setLocation(null);
    const none = await placeViaRoute({ paymentMethod: "WALLET" });
    expect(none.status).toBe(422);
    expect(none.body.error.details).toMatchObject({ missing: "location" });
    setLocation("400001");
    const far = await placeViaRoute({ paymentMethod: "WALLET" });
    expect(far.status).toBe(422);
    expect(far.body.error.message).toMatch(/does not deliver to your location/);
    expect(await db.select().from(orders)).toHaveLength(0);
    setLocation("411001");
    expect((await placeViaRoute({ paymentMethod: "WALLET" })).status).toBe(201);
  });

  it("TC-OV2C-031 the customer may cancel a waiting order after the shop accepted it; the shop is told", async () => {
    await v2On();
    const { user, owner, orderId } = await pendingOrder();
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, orderId));
    signInAs(user);
    const res = await call(orderStatusRoute as never, `/api/orders/${orderId}/status`, { method: "PATCH", params: { id: orderId }, body: { status: "CANCELLED", note: "No address" } });
    expect(res.status).toBe(200);
    // Paid from the wallet: cancelled and refunded to the wallet in full.
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0].status).toBe("REFUNDED");
    const shopNotes = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.ORDER_CANCELLED)));
    expect(shopNotes).toHaveLength(1);
  });

  it("TC-OV2C-032 a paid online order cancelled while waiting is refunded in full", async () => {
    await v2On();
    await setRule("onlinePayments", { enabled: true }, adminActor());
    const { user, placed, orderId } = await pendingOrder("ONLINE");
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, placed.body.payment.intentId));
    const webhook = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
    await webhookRoute(new NextRequest("http://localhost/api/webhooks/payments/sandbox", { method: "POST", body: webhook.rawBody, headers: webhook.headers }), {
      params: Promise.resolve({ gateway: "sandbox" }),
    });
    await db.update(orders).set({ status: "ACCEPTED" }).where(eq(orders.id, orderId));
    signInAs(user);
    const res = await call(orderStatusRoute as never, `/api/orders/${orderId}/status`, { method: "PATCH", params: { id: orderId }, body: { status: "CANCELLED" } });
    expect(res.status).toBe(200);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(["REFUND_PENDING", "REFUNDED"]).toContain(order.status);
    const [after] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    // Full refund to the original method: everything captured comes back.
    expect(after.refundedPaise).toBe(after.amountPaise);
  });

  it("TC-OV2C-033 waiting past onboardingV2.addressPendingAutoCancelHours: cancelled automatically, shop told", async () => {
    await v2On();
    const { owner, orderId } = await pendingOrder();
    const recent = await pendingOrder();
    await db.update(orders).set({ addressPendingSince: new Date(Date.now() - 3 * 3_600_000) }).where(eq(orders.id, orderId));
    expect(await cancelStaleAddressPendingOrders()).toEqual({ cancelled: 1, failed: 0 });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order).toMatchObject({ status: "REFUNDED", cancellationReason: ADDRESS_PENDING_TIMEOUT_REASON });
    expect((await db.select().from(orders).where(eq(orders.id, recent.orderId)))[0].status).toBe("CONFIRMED");
    const shopNotes = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.ORDER_CANCELLED)));
    expect(shopNotes).toHaveLength(1);

    await setRule("onboardingV2", { addressPendingAutoCancelHours: 0 }, adminActor());
    await db.update(orders).set({ addressPendingSince: new Date(Date.now() - 10 * 3_600_000) }).where(eq(orders.id, recent.orderId));
    expect(await cancelStaleAddressPendingOrders()).toEqual({ cancelled: 0, failed: 0 });
  });

  it("TC-OV2C-034 the referral exemption covers the first checkout only, never a later order", async () => {
    await v2On();
    const { user, orderId } = await pendingOrder();
    expect(await firstCheckoutOrderIds(user.id, [orderId])).toEqual([orderId]);
    const { listing } = await shopWithMilk();
    await addToCart(user.id, listing.id, 1);
    await fundWallet(user.id);
    const second = await placeViaRoute({ paymentMethod: "WALLET" });
    const secondId = second.body.orders[0].id as string;
    expect(await firstCheckoutOrderIds(user.id, [secondId])).toEqual([]);
  });
});
