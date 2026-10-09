/**
 * Bank accounts and ₹1 verification (docs/four-features-2026-10, feature 3).
 *
 * Saving (validation, encryption at rest, masking, a change needs a new
 * verification), ₹1 verification by UPI, debit card, credit card and net
 * banking (test simulator, and Cashfree with its API mocked), failure and
 * retry, name mismatch, the automatic refund, the payout gate, prompts, and
 * who may do what.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  live: false,
  authUrl: undefined as string | undefined,
  /** What Cashfree reports when a pending refund is looked up again. */
  refundLater: undefined as string | undefined,
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

// Lets a test switch the gateway on (Cashfree, API mocked) or pretend to be gokesari.com.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    isPaymentGatewayLive: () => state.live,
    getEnv: () => ({
      ...actual.getEnv(),
      ...(state.live ? { CASHFREE_APP_ID: "test-app", CASHFREE_SECRET_KEY: "test-secret" } : {}),
      AUTH_URL: state.authUrl,
    }),
  };
});

import { GET as myAccountGet, PUT as myAccountPut } from "@/app/api/bank-account/route";
import { POST as startRoute } from "@/app/api/bank-account/verification/route";
import { POST as confirmRoute } from "@/app/api/bank-account/verification/confirm/route";
import { POST as simulateRoute } from "@/app/api/bank-account/verification/simulate/route";
import { PUT as shopAccountPut, GET as shopAccountGet } from "@/app/api/shops/[id]/bank-account/route";
import { GET as adminListRoute } from "@/app/api/admin/bank-accounts/route";
import { PATCH as settlementRoute } from "@/app/api/finance/settlements/[id]/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { bankAccounts, bankVerificationAttempts, notifications, platformSettings, shopSettlements } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { customerBankPrompt, matchPayment, readCashfreePayment } from "@/server/services/bank-accounts";
import { checkout } from "@/server/services/orders";
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
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
const realFetch = global.fetch;

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["bankAccounts"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  state.live = false;
  state.authUrl = undefined;
  state.refundLater = undefined;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setRule("bankAccounts", { enabled: true }, admin);
});

afterEach(() => {
  global.fetch = realFetch;
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const BANK = { method: "BANK_ACCOUNT", accountHolderName: "Ravi Kumar", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "SBIN0001234" };

async function saveMine(body: Record<string, unknown> = BANK) {
  return call(myAccountPut, "/api/bank-account", { method: "PUT", body });
}

async function start(accountId: string) {
  return call(startRoute, "/api/bank-account/verification", { method: "POST", body: { accountId } });
}

async function simulate(gatewayOrderId: string, method: string, outcome: string) {
  return call(simulateRoute, "/api/bank-account/verification/simulate", { method: "POST", body: { gatewayOrderId, method, outcome } });
}

/* ------------------------------------------------------------------ saving */

describe("saving bank details", () => {
  it("validates, encrypts the number, shows the last 4 only, and a change needs a new verification", async () => {
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");

    expect((await saveMine({ ...BANK, ifsc: "SBIN1001234" })).status).toBe(422); // 5th character must be 0
    expect((await saveMine({ ...BANK, accountNumber: "12345", confirmAccountNumber: "12345" })).status).toBe(422);
    const mismatch = await saveMine({ ...BANK, confirmAccountNumber: "123456789013" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details.fields.confirmAccountNumber).toBeDefined();
    expect((await saveMine({ method: "UPI", accountHolderName: "Ravi Kumar", upiId: "not-a-upi" })).status).toBe(422);

    const saved = await saveMine();
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ status: "PENDING", accountNumberMasked: "••••9012", ifsc: "SBIN0001234" });
    expect(JSON.stringify(saved.body)).not.toContain("123456789012");
    const [row] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, saved.body.id));
    expect(row.accountNumberEncrypted).not.toContain("123456789012");
    expect(row.accountNumberLast4).toBe("9012");

    // The same details again: the same account.
    expect((await saveMine()).body.id).toBe(saved.body.id);
    // New details: a new, unverified account; the old one is kept but no longer current.
    const changed = await saveMine({ method: "UPI", accountHolderName: "Ravi Kumar", upiId: "ravi.kumar@okicici" });
    expect(changed.body).toMatchObject({ status: "PENDING", method: "UPI", upiIdMasked: "ra••••••••@okicici" });
    expect(changed.body.id).not.toBe(saved.body.id);
    const [old] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, saved.body.id));
    expect(old.isCurrent).toBe(false);
  });
});

/* ------------------------------------------------------------- simulator */

describe("₹1 verification (test simulator)", () => {
  it("UPI: verified with the payer's name, gateway reference and refund recorded; the holder is told", async () => {
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ mode: "SIMULATOR", amountPaise: 100, paymentSessionId: null });

    const done = await simulate(started.body.gatewayOrderId, "UPI", "SUCCESS");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({
      status: "VERIFIED",
      matchedAccountHolderName: "Ravi Kumar",
      matchMethod: "GATEWAY_NAME",
      verificationPaymentMethod: "UPI",
    });
    expect(done.body.gatewayReference).toMatch(/^sim_/);
    expect(done.body.verifiedAt).not.toBeNull();
    const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.bankAccountId, saved.body.id));
    expect(attempt).toMatchObject({ status: "SUCCESS", refundStatus: "REFUNDED" });
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "wallet.bank_account_verified")))).toHaveLength(1);

    // Already verified: nothing more to pay.
    expect((await start(saved.body.id)).status).toBe(409);
    // Changing the details means verifying again.
    const changed = await saveMine({ ...BANK, accountNumber: "999988887777", confirmAccountNumber: "999988887777" });
    expect(changed.body.status).toBe("PENDING");
  });

  it.each([
    ["DEBIT_CARD", "PAYMENT_ONLY"],
    ["CREDIT_CARD", "PAYMENT_ONLY"],
    ["NET_BANKING", "GATEWAY_NAME"],
  ])("%s works too", async (method, matchMethod) => {
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    const done = await simulate(started.body.gatewayOrderId, method, "SUCCESS");
    expect(done.body).toMatchObject({ status: "VERIFIED", verificationPaymentMethod: method, matchMethod });
  });

  it("a failed payment fails the verification with a reason; a retry can succeed", async () => {
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const first = await start(saved.body.id);
    const failed = await simulate(first.body.gatewayOrderId, "CREDIT_CARD", "FAILED");
    expect(failed.body).toMatchObject({ status: "FAILED", failureReason: "Payment declined by the bank (test)." });
    const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.gatewayOrderId, first.body.gatewayOrderId));
    expect(attempt.refundStatus).toBe("NOT_REQUIRED"); // nothing was taken
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "wallet.bank_account_verification_failed")))).toHaveLength(1);
    // Replaying the same attempt changes nothing.
    expect((await simulate(first.body.gatewayOrderId, "UPI", "SUCCESS")).body.status).toBe("FAILED");

    const retry = await start(saved.body.id);
    const ok = await simulate(retry.body.gatewayOrderId, "UPI", "SUCCESS");
    expect(ok.body.status).toBe("VERIFIED");
  });

  it("a payment from a different account holder fails (and the ₹1 is still refunded)", async () => {
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    const done = await simulate(started.body.gatewayOrderId, "UPI", "NAME_MISMATCH");
    expect(done.body.status).toBe("FAILED");
    expect(done.body.failureReason).toContain("does not match");
    const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.gatewayOrderId, started.body.gatewayOrderId));
    expect(attempt.refundStatus).toBe("REFUNDED");
  });

  it("limits attempts per day", async () => {
    await setRule("bankAccounts", { enabled: true, maxAttemptsPerDay: 2 }, admin);
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    expect((await start(saved.body.id)).status).toBe(201);
    resetRateLimits();
    expect((await start(saved.body.id)).status).toBe(201);
    resetRateLimits();
    expect((await start(saved.body.id)).status).toBe(429);
  });

  it("is never offered on the production site", async () => {
    state.authUrl = "https://gokesari.com";
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    expect((await call(myAccountGet, "/api/bank-account")).body.gateway).toBe("UNAVAILABLE");
    expect((await start(saved.body.id)).status).toBe(409);
  });
});

/* ------------------------------------------------------------- Cashfree */

describe("₹1 verification through Cashfree (API mocked)", () => {
  function mockCashfree(payments: unknown[], refund = { cf_refund_id: "rf_1", refund_status: "PENDING" }) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/orders") && init?.method === "POST") return new Response(JSON.stringify({ payment_session_id: "session_123" }), { status: 200 });
      if (url.includes("/payments")) return new Response(JSON.stringify(payments), { status: 200 });
      if (url.endsWith("/refunds")) return new Response(JSON.stringify(refund), { status: 200 });
      if (url.includes("/refunds/")) return new Response(JSON.stringify({ cf_refund_id: refund.cf_refund_id, refund_status: state.refundLater ?? "PENDING" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return calls;
  }

  it("offers UPI, debit card, credit card and net banking; confirms with Cashfree; refunds the ₹1", async () => {
    state.live = true;
    const calls = mockCashfree([
      {
        cf_payment_id: 4455,
        payment_status: "SUCCESS",
        payment_group: "debit_card",
        payment_method: { card: { card_network: "visa", card_type: "debit_card", card_bank_name: "HDFC BANK", card_number: "470613XXXXXX1381" } },
      },
    ]);
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    expect(started.body).toMatchObject({ mode: "CASHFREE", paymentSessionId: "session_123" });
    const order = calls.find((c) => c.url.endsWith("/orders"))!;
    expect(order.body).toMatchObject({ order_amount: 1, order_meta: { payment_methods: "upi,dc,cc,nb" } });
    // No card or bank number ever goes to the gateway from us.
    expect(JSON.stringify(order.body)).not.toContain("123456789012");

    // The simulator is refused when the gateway is live.
    expect((await simulate(started.body.gatewayOrderId, "UPI", "SUCCESS")).status).toBe(404);

    const done = await call(confirmRoute, "/api/bank-account/verification/confirm", { method: "POST", body: { gatewayOrderId: started.body.gatewayOrderId } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "VERIFIED", verificationPaymentMethod: "DEBIT_CARD", gatewayReference: "4455", matchMethod: "PAYMENT_ONLY" });
    const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.gatewayOrderId, started.body.gatewayOrderId));
    expect(attempt).toMatchObject({ refundStatus: "PENDING", refundReference: "rf_1" });
    expect(JSON.stringify(attempt.payerDetails)).not.toContain("470613");
    expect(calls.some((c) => c.url.endsWith("/refunds") && (c.body as { refund_amount: number }).refund_amount === 1)).toBe(true);
  });

  it("a refund Cashfree settles later shows as refunded the next time the account is opened", async () => {
    state.live = true;
    const calls = mockCashfree([{ cf_payment_id: 77, payment_status: "SUCCESS", payment_group: "upi", payment_method: { upi: { upi_id: "ravi@okhdfc" } } }]);
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    await call(confirmRoute, "/api/bank-account/verification/confirm", { method: "POST", body: { gatewayOrderId: started.body.gatewayOrderId } });
    expect((await call(myAccountGet, "/api/bank-account")).body.account.lastAttempt.refundStatus).toBe("PENDING");

    state.refundLater = "SUCCESS";
    const shown = await call(myAccountGet, "/api/bank-account");
    expect(shown.body.account.lastAttempt.refundStatus).toBe("REFUNDED");
    const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.gatewayOrderId, started.body.gatewayOrderId));
    expect(attempt.refundedAt).not.toBeNull();
    // Asked by our own refund id; once REFUNDED, Cashfree is not asked again.
    const checks = calls.filter((c) => c.url.includes("/refunds/bvr_")).length;
    await call(myAccountGet, "/api/bank-account");
    expect(calls.filter((c) => c.url.includes("/refunds/bvr_")).length).toBe(checks);
  });

  it("a payment Cashfree reports as failed fails the verification", async () => {
    state.live = true;
    mockCashfree([{ cf_payment_id: 1, payment_status: "FAILED", payment_group: "upi", payment_message: "Payer declined", payment_method: { upi: { upi_id: "x@ybl" } } }]);
    const customer = await createUser({ name: "Ravi Kumar" });
    signIn(customer, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    const done = await call(confirmRoute, "/api/bank-account/verification/confirm", { method: "POST", body: { gatewayOrderId: started.body.gatewayOrderId } });
    expect(done.body).toMatchObject({ status: "FAILED", failureReason: "Payer declined" });
  });

  it("reads the gateway's payer account / UPI ID and refuses a different one", () => {
    const upi = readCashfreePayment({ payment_status: "SUCCESS", payment_group: "upi", payment_method: { upi: { upi_id: "Ravi@OKICICI" } } });
    expect(upi).toMatchObject({ method: "UPI", payerUpiId: "ravi@okicici" });
    const nb = readCashfreePayment({
      payment_status: "SUCCESS",
      payment_group: "net_banking",
      payment_method: { netbanking: { netbanking_bank_name: "SBI", netbanking_ifsc: "sbin0001234", netbanking_account_number: "XXXXXXXX9012" } },
    });
    const account = { method: "BANK_ACCOUNT" as const, accountHolderName: "Ravi Kumar", accountNumberLast4: "9012", ifsc: "SBIN0001234", upiIdEncrypted: null };
    expect(matchPayment(account, nb, 80)).toMatchObject({ verified: true, method: "GATEWAY_ACCOUNT" });
    expect(matchPayment({ ...account, accountNumberLast4: "1111" }, nb, 80)).toMatchObject({ verified: false });
    expect(matchPayment(account, { ...nb, payerName: "Ravi Kumaar" }, 80)).toMatchObject({ verified: true, method: "GATEWAY_NAME" });
    expect(matchPayment(account, { ...nb, payerName: "Sunita Sharma" }, 80)).toMatchObject({ verified: false, method: "GATEWAY_NAME" });
  });
});

/* -------------------------------------------------------- shops & payouts */

describe("shop payout account", () => {
  it("only the owner sets it; payouts wait for a verified account when the rule says so", async () => {
    await setRule("bankAccounts", { enabled: true, requireVerifiedForShopPayouts: true }, admin);
    const owner = await createUser({ role: "SHOP_OWNER", name: "Asha Patil" });
    const shop = await createShop(owner.id);
    const [settlement] = await db
      .insert(shopSettlements)
      .values({ shopId: shop.id, periodStart: "2026-09-01", periodEnd: "2026-09-08", orderCount: 1, goodsPaise: 10_000, commissionPaise: 100, refundsPaise: 0, adjustmentsPaise: 0, netPayablePaise: 9_900, status: "ELIGIBLE" })
      .returning();

    const stranger = await createUser({ role: "SHOP_OWNER" });
    signIn(stranger, "SHOP_OWNER");
    expect((await call(shopAccountPut, `/api/shops/${shop.id}/bank-account`, { method: "PUT", body: BANK, params: { id: shop.id } })).status).toBe(403);
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    // Finance staff may look, not change.
    expect((await call(shopAccountPut, `/api/shops/${shop.id}/bank-account`, { method: "PUT", body: BANK, params: { id: shop.id } })).status).toBe(403);

    const adminUser = { id: admin.id, email: "admin@test.local", name: "Admin" };
    signIn(adminUser, "ADMIN");
    const blocked = await call(settlementRoute, `/api/finance/settlements/${settlement.id}`, { method: "PATCH", body: { action: "process" }, params: { id: settlement.id } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain("no verified bank account");

    signIn(owner, "SHOP_OWNER");
    const saved = await call(shopAccountPut, `/api/shops/${shop.id}/bank-account`, {
      method: "PUT",
      body: { ...BANK, accountHolderName: "Asha Patil" },
      params: { id: shop.id },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.holderType).toBe("SHOP");
    const started = await start(saved.body.id);
    expect((await simulate(started.body.gatewayOrderId, "NET_BANKING", "SUCCESS")).body.status).toBe("VERIFIED");
    expect((await call(shopAccountGet, `/api/shops/${shop.id}/bank-account`, { params: { id: shop.id } })).body.account.status).toBe("VERIFIED");

    signIn(adminUser, "ADMIN");
    const processed = await call(settlementRoute, `/api/finance/settlements/${settlement.id}`, { method: "PATCH", body: { action: "process" }, params: { id: settlement.id } });
    expect(processed.status, JSON.stringify(processed.body)).toBe(200);

    // Finance list (masked): admin yes, a customer no.
    const list = await call(adminListRoute, "/api/admin/bank-accounts?holderType=SHOP");
    expect(list.status).toBe(200);
    expect(list.body.accounts[0]).toMatchObject({ shopName: shop.name, status: "VERIFIED", accountNumberMasked: "••••9012" });
    expect(JSON.stringify(list.body)).not.toContain("123456789012");
    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    expect((await call(adminListRoute, "/api/admin/bank-accounts")).status).toBe(403);
  });

  it("with the payout rule off (default), payouts go ahead as before", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const [settlement] = await db
      .insert(shopSettlements)
      .values({ shopId: shop.id, periodStart: "2026-09-01", periodEnd: "2026-09-08", orderCount: 1, goodsPaise: 10_000, commissionPaise: 100, refundsPaise: 0, adjustmentsPaise: 0, netPayablePaise: 9_900, status: "ELIGIBLE" })
      .returning();
    signIn({ id: admin.id, email: "admin@test.local", name: "Admin" }, "ADMIN");
    expect((await call(settlementRoute, `/api/finance/settlements/${settlement.id}`, { method: "PATCH", body: { action: "process" }, params: { id: settlement.id } })).status).toBe(200);
  });
});

/* ------------------------------------------------------- prompts & access */

describe("prompts and access", () => {
  it("a customer is prompted at the first checkout and in the profile, never blocked", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const cat = await createCategory();
    const sp = await createShopProduct(shop.id, (await createProduct(cat.id)).id);
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });
    expect(await customerBankPrompt(user.id, "checkout")).toBe("NONE");
    expect(await customerBankPrompt(user.id, "profile")).toBe("NONE");
    await addToCart(user.id, sp.id, 1);
    const placed = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: "first" });
    expect(placed.orders).toHaveLength(1); // no lockout
    expect(await customerBankPrompt(user.id, "checkout")).toBeNull(); // only at the first checkout
    expect(await customerBankPrompt(user.id, "profile")).toBe("NONE");
    await setRule("bankAccounts", { enabled: false }, admin);
    expect(await customerBankPrompt(user.id, "profile")).toBeNull();
  });

  it("nobody can start or confirm a verification of someone else's account", async () => {
    const ravi = await createUser({ name: "Ravi Kumar" });
    signIn(ravi, "CUSTOMER");
    const saved = await saveMine();
    const started = await start(saved.body.id);
    const other = await createUser();
    signIn(other, "CUSTOMER");
    expect((await start(saved.body.id)).status).toBe(404);
    expect((await simulate(started.body.gatewayOrderId, "UPI", "SUCCESS")).status).toBe(404);
    state.session = null;
    expect((await saveMine()).status).toBe(401);
  });
});
