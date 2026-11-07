/**
 * Cashfree audit fixes (docs/payments-cashfree-audit-2026-11), real PostgreSQL,
 * Cashfree's API mocked by URL:
 *
 *  - a top-up whose UPI / bank payment is still PENDING is left open (not
 *    FAILED) when the customer's check comes back early;
 *  - a top-up marked FAILED that Cashfree later reports paid is credited — by
 *    the signed webhook (after Cashfree's own API confirms it) or by the
 *    customer's own check — exactly once;
 *  - Cashfree reporting less money than the top-up credits nothing;
 *  - the payments-reconcile job credits a paid top-up whose webhook never
 *    came, fails one with no payment after an hour, and keeps asking about a
 *    pending one;
 *  - a registration fee paid at Cashfree is approved by the reconcile job
 *    and by the applicant's "check payment", with the webhook's own checks;
 *  - top-up orders carry a notify_url (https only) and an expiry.
 */
import { createHmac } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as webhookRoute } from "@/app/api/webhooks/cashfree/route";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { auditLogs, outboundTestMessages, payments, platformSettings, referralCodes, registrationFeeTiers, registrationPayments, shopRegistrations, wallets } from "@/server/db/schema";
import { sendRegistrationOtp } from "@/server/registration/otp";
import { checkRegistrationPayment, createRegistration, reconcileRegistrationPayments, startRegistrationPayment } from "@/server/registration/service";
import { createTopUpOrder, reconcileCashfreeTopUps, verifyAndCreditTopUp } from "@/server/services/payments";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createUser, createUserWithWallet, resetDatabase, uniqueMobile } from "../helpers/fixtures";

const env = getEnv() as { CASHFREE_APP_ID?: string; AUTH_URL?: string; PAYMENT_PUBLIC_BASE_URL?: string };
const before = { appId: env.CASHFREE_APP_ID, authUrl: env.AUTH_URL, publicBase: env.PAYMENT_PUBLIC_BASE_URL };
const realFetch = global.fetch;

interface Attempt {
  cf_payment_id: string | number;
  payment_status: string;
  payment_amount?: number;
  payment_currency?: string;
}

/** Cashfree by URL: /orders (create), /orders/{id} (get), /orders/{id}/payments. Records every call. */
function mockCashfree(byOrder: Record<string, Attempt[]>, order: { order_amount?: number; order_currency?: string } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/orders") && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { order_id: string };
      return new Response(JSON.stringify({ order_id: body.order_id, payment_session_id: "session_test_123" }), { status: 200 });
    }
    const paymentsMatch = /\/orders\/([^/]+)\/payments$/.exec(url);
    if (paymentsMatch) return new Response(JSON.stringify(byOrder[decodeURIComponent(paymentsMatch[1])] ?? []), { status: 200 });
    const orderMatch = /\/orders\/([^/]+)$/.exec(url);
    if (orderMatch) {
      return new Response(JSON.stringify({ order_id: decodeURIComponent(orderMatch[1]), order_status: "ACTIVE", order_amount: order.order_amount ?? 1, order_currency: order.order_currency ?? "INR" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return calls;
}

/** A top-up made offline, then turned into a Cashfree order with (fake) keys set. */
async function cashfreeTopUp(userId: string, amountPaise: number, ageMinutes = 0) {
  env.CASHFREE_APP_ID = ""; // made offline (mock), whatever an earlier call left set
  const intent = await createTopUpOrder(userId, amountPaise);
  await db
    .update(payments)
    .set({ gateway: "CASHFREE", ...(ageMinutes ? { createdAt: new Date(Date.now() - ageMinutes * 60_000) } : {}) })
    .where(eq(payments.gatewayOrderId, intent.gatewayOrderId));
  env.CASHFREE_APP_ID = "test-app";
  return intent;
}

const balanceOf = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const paymentRow = async (gatewayOrderId: string) => (await db.query.payments.findFirst({ where: eq(payments.gatewayOrderId, gatewayOrderId) }))!;

function signedWebhook(body: unknown) {
  const raw = JSON.stringify(body);
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

function successWebhook(orderId: string, paymentId: string, rupees: number) {
  return {
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: {
      order: { order_id: orderId, order_amount: rupees, order_currency: "INR" },
      payment: { cf_payment_id: paymentId, payment_status: "SUCCESS", payment_amount: rupees, payment_currency: "INR" },
    },
  };
}

beforeEach(resetDatabase);
afterEach(() => {
  global.fetch = realFetch;
  env.CASHFREE_APP_ID = before.appId;
  env.AUTH_URL = before.authUrl;
  env.PAYMENT_PUBLIC_BASE_URL = before.publicBase;
});

describe("top-up still pending at the bank", () => {
  it("is left open (not FAILED) when the customer's check comes back before the bank confirms", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 50_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 11, payment_status: "PENDING" }] });

    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId })).rejects.toMatchObject({
      code: "PAYMENT_VERIFICATION_FAILED",
      message: expect.stringContaining("not confirmed this payment yet"),
    });
    expect((await paymentRow(intent.gatewayOrderId)).status).toBe("CREATED");

    // The bank confirms; the customer checks again: credited.
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 11, payment_status: "SUCCESS", payment_amount: 500, payment_currency: "INR" }] });
    const result = await verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId });
    expect(result.balancePaise).toBe(50_000);
  });

  it("still fails a payment whose every attempt failed (as before)", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 50_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 12, payment_status: "FAILED" }, { cf_payment_id: 13, payment_status: "USER_DROPPED" }] });
    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId })).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });
    expect((await paymentRow(intent.gatewayOrderId)).status).toBe("FAILED");
  });
});

describe("a top-up marked FAILED that Cashfree later reports paid", () => {
  async function failedTopUp(amountPaise: number) {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, amountPaise);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 21, payment_status: "FAILED" }] });
    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId })).rejects.toBeTruthy();
    expect((await paymentRow(intent.gatewayOrderId)).status).toBe("FAILED");
    return { user, intent };
  }

  it("is credited once by the signed webhook, after Cashfree's own API confirms it", async () => {
    const { user, intent } = await failedTopUp(30_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 22, payment_status: "SUCCESS", payment_amount: 300, payment_currency: "INR" }] });

    const res = await signedWebhook(successWebhook(intent.gatewayOrderId, "22", 300));
    expect(res.status).toBe(200);
    expect(await balanceOf(user.id)).toBe(30_000);
    expect((await paymentRow(intent.gatewayOrderId)).status).toBe("SUCCESS");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "wallet.topup_late_success"));
    expect(audit).toHaveLength(1);

    // Cashfree's retry of the same webhook changes nothing.
    expect((await signedWebhook(successWebhook(intent.gatewayOrderId, "22", 300))).status).toBe(200);
    expect(await balanceOf(user.id)).toBe(30_000);
  });

  it("is not credited when Cashfree's own API does not confirm the webhook", async () => {
    const { user, intent } = await failedTopUp(30_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 21, payment_status: "FAILED" }] });
    expect((await signedWebhook(successWebhook(intent.gatewayOrderId, "99", 300))).status).toBe(200);
    expect(await balanceOf(user.id)).toBe(0);
    expect((await paymentRow(intent.gatewayOrderId)).status).toBe("FAILED");
  });

  it("is credited when the customer checks again", async () => {
    const { user, intent } = await failedTopUp(20_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 23, payment_status: "SUCCESS", payment_amount: 200 }] });
    const result = await verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId });
    expect(result.balancePaise).toBe(20_000);
    expect(result.alreadyProcessed).toBe(false);
  });

  it("is never credited to someone else checking it", async () => {
    const { user, intent } = await failedTopUp(20_000);
    const { user: other } = await createUserWithWallet({ balancePaise: 0 });
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 24, payment_status: "SUCCESS", payment_amount: 200 }] });
    await expect(verifyAndCreditTopUp({ userId: other.id, gatewayOrderId: intent.gatewayOrderId })).rejects.toBeTruthy();
    expect(await balanceOf(other.id)).toBe(0);
    expect(await balanceOf(user.id)).toBe(0);
  });
});

describe("amount and currency are checked against Cashfree's record", () => {
  it("credits nothing when Cashfree reports less money than the top-up", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 100_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 31, payment_status: "SUCCESS", payment_amount: 1, payment_currency: "INR" }] });
    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId })).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });
    expect(await balanceOf(user.id)).toBe(0);
    const row = await paymentRow(intent.gatewayOrderId);
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toContain("nothing was credited");
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "wallet.topup_amount_mismatch"))).toHaveLength(1);
  });

  it("credits nothing when the signed webhook reports another currency or a smaller amount", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 100_000);
    const lower = successWebhook(intent.gatewayOrderId, "32", 10);
    expect((await signedWebhook(lower)).status).toBe(200);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("credits the top-up when the customer paid a convenience fee on top", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 100_000);
    mockCashfree({ [intent.gatewayOrderId]: [{ cf_payment_id: 33, payment_status: "SUCCESS", payment_amount: 1020, payment_currency: "INR" }] });
    const result = await verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId });
    expect(result.balancePaise).toBe(100_000);
  });
});

describe("payments-reconcile: Cashfree top-ups the webhook never confirmed", () => {
  it("credits a paid one, keeps asking about a pending one, fails an unpaid one after an hour", async () => {
    const { user: a } = await createUserWithWallet({ balancePaise: 0 });
    const { user: b } = await createUserWithWallet({ balancePaise: 0 });
    const { user: c } = await createUserWithWallet({ balancePaise: 0 });
    const paid = await cashfreeTopUp(a.id, 40_000, 20);
    const pending = await cashfreeTopUp(b.id, 10_000, 20);
    const abandoned = await cashfreeTopUp(c.id, 10_000, 90);
    const fresh = await cashfreeTopUp(c.id, 10_000, 2);
    const calls = mockCashfree({
      [paid.gatewayOrderId]: [{ cf_payment_id: 41, payment_status: "SUCCESS", payment_amount: 400 }],
      [pending.gatewayOrderId]: [{ cf_payment_id: 42, payment_status: "PENDING" }],
      [abandoned.gatewayOrderId]: [],
    });

    const result = await reconcileCashfreeTopUps();
    expect(result).toMatchObject({ checked: 3, credited: 1, failed: 1, stillPending: 1, errors: [] });
    expect(await balanceOf(a.id)).toBe(40_000);
    expect((await paymentRow(pending.gatewayOrderId)).status).toBe("CREATED");
    expect((await paymentRow(abandoned.gatewayOrderId)).status).toBe("FAILED");
    // Too new to ask about yet.
    expect(calls.some((x) => x.url.includes(fresh.gatewayOrderId))).toBe(false);

    // A second run does not credit again.
    const again = await reconcileCashfreeTopUps();
    expect(again.credited).toBe(0);
    expect(await balanceOf(a.id)).toBe(40_000);
  });

  it("does nothing without Cashfree keys", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    await cashfreeTopUp(user.id, 10_000, 30);
    env.CASHFREE_APP_ID = "";
    const calls = mockCashfree({});
    expect(await reconcileCashfreeTopUps()).toMatchObject({ checked: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("top-up orders sent to Cashfree", () => {
  it("carry the webhook URL (https only) and an expiry", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    env.CASHFREE_APP_ID = "test-app";
    env.PAYMENT_PUBLIC_BASE_URL = "https://test.gokesari.com";
    const calls = mockCashfree({});
    const intent = await createTopUpOrder(user.id, 10_000);
    expect(intent.paymentSessionId).toBe("session_test_123");
    const created = calls.find((x) => x.url.endsWith("/orders"))!.body as { order_meta?: { notify_url?: string }; order_expiry_time?: string };
    expect(created.order_meta?.notify_url).toBe("https://test.gokesari.com/api/webhooks/cashfree");
    expect(new Date(created.order_expiry_time!).getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);

    env.PAYMENT_PUBLIC_BASE_URL = "http://localhost:3000";
    const calls2 = mockCashfree({});
    await createTopUpOrder(user.id, 10_000);
    expect((calls2.find((x) => x.url.endsWith("/orders"))!.body as { order_meta?: unknown }).order_meta).toBeUndefined();
  });
});

describe("registration fee paid at Cashfree, webhook lost", () => {
  let admin = { id: "", role: "ADMIN" as const };

  beforeEach(async () => {
    await db.delete(outboundTestMessages);
    await db.delete(platformSettings).where(inArray(platformSettings.key, ["selfRegistration", "otp"]));
    clearRuleCache();
    admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
    await setRule("selfRegistration", { enabled: true, holdHours: 24, maxPendingPerMobile: 3, classification: "GREEN" }, admin);
    await db.insert(registrationFeeTiers).values([{ code: "BASIC", label: "Basic", amountPaise: 100_000, isActive: true, sortOrder: 1 }]);
    await db.insert(referralCodes).values({ code: "AUDIT11", createdBy: admin.id, status: "ACTIVE" });
  });

  async function registerAndStart() {
    const mobile = uniqueMobile();
    await sendRegistrationOtp(`+91${mobile}`, null);
    const rows = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`));
    const otp = /(\d{4,8})/.exec(rows.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0].body)![1];
    const { token } = await createRegistration({ shopName: "Audit Kirana", mobile, referralCode: "AUDIT11", tierCode: "BASIC", otp, acceptTerms: true }, "127.0.0.1");
    const pay = await startRegistrationPayment(token); // mock mode: no keys yet
    // Make it a Cashfree order, as on a site with keys.
    await db.update(registrationPayments).set({ gateway: "CASHFREE", createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(registrationPayments.gatewayOrderId, pay.orderId));
    env.CASHFREE_APP_ID = "test-app";
    return { token, orderId: pay.orderId };
  }

  it("is approved by the payments-reconcile job from Cashfree's own record", async () => {
    const { token, orderId } = await registerAndStart();
    mockCashfree({ [orderId]: [{ cf_payment_id: "cf-reg-1", payment_status: "SUCCESS", payment_amount: 1000, payment_currency: "INR" }] }, { order_amount: 1000 });
    const result = await reconcileRegistrationPayments();
    expect(result).toMatchObject({ checked: 1, approved: 1, errors: [] });
    const [reg] = await db.select().from(shopRegistrations);
    expect(reg.status).toBe("APPROVED");
    expect((await checkRegistrationPayment(token)).status).toBe("APPROVED");
    // Once approved, a second run asks nothing more.
    expect((await reconcileRegistrationPayments()).checked).toBe(0);
  });

  it("is approved when the applicant's page asks, and refused when the amount is not the fee", async () => {
    const ok = await registerAndStart();
    mockCashfree({ [ok.orderId]: [{ cf_payment_id: "cf-reg-2", payment_status: "SUCCESS", payment_amount: 1000 }] }, { order_amount: 1000 });
    expect(await checkRegistrationPayment(ok.token)).toEqual({ status: "APPROVED", outcome: "APPROVED" });

    const short = await registerAndStart();
    mockCashfree({ [short.orderId]: [{ cf_payment_id: "cf-reg-3", payment_status: "SUCCESS", payment_amount: 1 }] }, { order_amount: 1000 });
    expect(await checkRegistrationPayment(short.token)).toEqual({ status: "PENDING_PAYMENT", outcome: "MISMATCH" });
    const [payment] = await db.select().from(registrationPayments).where(and(eq(registrationPayments.gatewayOrderId, short.orderId)));
    expect(payment.status).toBe("MISMATCH");
  });

  it("stays pending (nothing changes) while Cashfree has no successful payment", async () => {
    const { token, orderId } = await registerAndStart();
    mockCashfree({ [orderId]: [{ cf_payment_id: "cf-reg-4", payment_status: "PENDING" }] }, { order_amount: 1000 });
    expect(await checkRegistrationPayment(token)).toEqual({ status: "PENDING_PAYMENT", outcome: null });
    const [payment] = await db.select().from(registrationPayments).where(eq(registrationPayments.gatewayOrderId, orderId));
    expect(payment.status).toBe("CREATED");
  });
});

describe("Admin → Cashfree set-up & tests", () => {
  it("reports the set-up without secrets, and Cashfree's eligible payment methods when asked live", async () => {
    const { cashfreeHealth } = await import("@/server/payments/cashfree-health");
    const admin = await createUser({ role: "ADMIN" });
    env.CASHFREE_APP_ID = "TEST10999";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eligibility/payment_methods")) {
        return new Response(
          JSON.stringify([
            { eligibility: true, entity_type: "payment_methods", entity_value: "upi" },
            { eligibility: true, entity_type: "payment_methods", entity_value: "card" },
            { eligibility: true, entity_type: "payment_methods", entity_value: "app", entity_details: { payment_method_details: [{ nick: "phonepe", display: "PhonePe", eligibility: true }, { nick: "paytm", display: "Paytm", eligibility: true }] } },
            { eligibility: false, entity_type: "payment_methods", entity_value: "paylater" },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "order not found" }), { status: 404 });
    }) as typeof fetch;
    const report = await cashfreeHealth({ id: admin.id, role: "ADMIN" }, { live: true });
    expect(report.pg).toMatchObject({ configured: true, env: "sandbox", keyKind: "sandbox", apiBase: "https://sandbox.cashfree.com/pg" });
    expect(report.live?.keysAccepted).toBe(true);
    expect(report.live?.eligibility.methods.find((m) => m.method === "app")).toEqual({ method: "app", eligible: true, options: ["PhonePe", "Paytm"] });
    expect(report.live?.eligibility.methods.find((m) => m.method === "paylater")?.eligible).toBe(false);
    expect(JSON.stringify(report)).not.toContain(process.env.CASHFREE_SECRET_KEY!);

    const customer = await createUser({ role: "CUSTOMER" });
    await expect(cashfreeHealth({ id: customer.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  function mockLiveTestCashfree(orderRupees: number) {
    const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
    const refunds: { refund_id: string; cf_refund_id: number; refund_status: string; refund_amount: number }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/orders") && method === "POST") return new Response(JSON.stringify({ order_id: body!.order_id, payment_session_id: "session_live_1" }), { status: 200 });
      if (/\/payments$/.test(url)) {
        return new Response(JSON.stringify([{ cf_payment_id: 900001, payment_status: "SUCCESS", payment_group: "wallet", payment_amount: orderRupees, payment_time: "2026-11-07T19:30:00+05:30", payment_method: { app: { provider: "phonepe" } } }]), { status: 200 });
      }
      if (url.endsWith("/refunds") && method === "POST") {
        const created = { refund_id: String(body!.refund_id), cf_refund_id: 7000 + refunds.length + 1, refund_status: "PENDING", refund_amount: Number(body!.refund_amount) };
        refunds.push(created);
        return new Response(JSON.stringify(created), { status: 200 });
      }
      if (url.endsWith("/refunds")) return new Response(JSON.stringify(refunds.map((r) => ({ ...r, refund_status: "SUCCESS" }))), { status: 200 });
      return new Response(JSON.stringify({ order_id: "x", order_status: "PAID", order_amount: orderRupees }), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  it("₹1 test: opens a fixed ₹1 order, reads Cashfree's record and refunds it once", async () => {
    const { finishCashfreeLiveTest, listCashfreeLiveTests, startCashfreeLiveTest } = await import("@/server/payments/cashfree-health");
    const admin = await createUser({ role: "ADMIN" });
    const actor = { id: admin.id, role: "ADMIN" as const };
    env.CASHFREE_APP_ID = "TEST10999";
    const calls = mockLiveTestCashfree(1);

    const started = await startCashfreeLiveTest(actor);
    expect(started).toMatchObject({ paymentSessionId: "session_live_1", mode: "sandbox", amountPaise: 100 });
    expect(started.orderId).toMatch(/^gktest_\d{14}_[0-9a-f]{6}$/);
    expect(calls[0].body).toMatchObject({ order_amount: 1, order_currency: "INR" });

    const done = await finishCashfreeLiveTest(started.orderId, actor);
    expect(done).toMatchObject({ paid: true, remainingPaise: 0, attempts: [{ cfPaymentId: "900001", status: "SUCCESS", group: "wallet", instrument: "wallet phonepe" }], refund: { cfRefundId: "7001", status: "PENDING", amountPaise: 100 } });
    // Asked again: the same refund is read back, never a second one.
    const again = await finishCashfreeLiveTest(started.orderId, actor);
    expect(again.refunds).toHaveLength(1);
    expect(again.refund).toMatchObject({ cfRefundId: "7001", status: "SUCCESS" });
    expect(calls.filter((c) => c.url.endsWith("/refunds") && c.method === "POST")).toHaveLength(1);

    // Only orders this site started can be finished; the list keeps every step.
    await expect(finishCashfreeLiveTest("gktest_20261107000000_abcdef", actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(finishCashfreeLiveTest("topup_1_ab", actor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await listCashfreeLiveTests(actor)).map((t) => t.action)).toEqual(["cashfree.live_test_finished", "cashfree.live_test_finished", "cashfree.live_test_started"]);
  });

  it("₹2 test: a partial refund of ₹1, then the rest", async () => {
    const { finishCashfreeLiveTest, startCashfreeLiveTest } = await import("@/server/payments/cashfree-health");
    const admin = await createUser({ role: "ADMIN" });
    const actor = { id: admin.id, role: "ADMIN" as const };
    env.CASHFREE_APP_ID = "TEST10999";
    const calls = mockLiveTestCashfree(2);
    const started = await startCashfreeLiveTest(actor, { amountPaise: 200 });
    expect(calls[0].body).toMatchObject({ order_amount: 2 });

    const partial = await finishCashfreeLiveTest(started.orderId, actor, { refund: "partial" });
    expect(partial).toMatchObject({ remainingPaise: 100, refunds: [{ amountPaise: 100 }] });
    // A second "partial" leaves the last rupee alone; "full" sends it back.
    expect((await finishCashfreeLiveTest(started.orderId, actor, { refund: "partial" })).refunds).toHaveLength(1);
    const rest = await finishCashfreeLiveTest(started.orderId, actor, { refund: "full" });
    expect(rest).toMatchObject({ remainingPaise: 0 });
    expect(rest.refunds.map((r) => [r.refundId.endsWith("_1") || r.refundId.endsWith("_2"), r.amountPaise])).toEqual([[true, 100], [true, 100]]);
    expect(calls.filter((c) => c.url.endsWith("/refunds") && c.method === "POST").map((c) => c.body!.refund_amount)).toEqual([1, 1]);
    // Anything but ₹1 / ₹2 is a ₹1 test.
    const odd = await startCashfreeLiveTest(actor, { amountPaise: 5000 });
    expect(odd.amountPaise).toBe(100);
  });
});
