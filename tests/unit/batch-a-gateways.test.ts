/**
 * batch-2026-10 WS-A — payment gateway adapters (no network: fetch is stubbed)
 * and the payment-intent state machine.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canMove, STATE_MACHINES } from "@/lib/state-machines";
import { PAYMENT_INTENT_STATUSES, PAYMENT_INTENT_TRANSITIONS } from "@/lib/payment-intent-states";
import { CashfreeGateway, mapCashfreeOrder } from "@/server/payments/gateway/cashfree";
import { isFresh } from "@/server/payments/gateway/common";
import { PhonePeGateway } from "@/server/payments/gateway/phonepe";
import { RazorpayGateway } from "@/server/payments/gateway/razorpay";
import { getPaymentGateway, parseGatewayName } from "@/server/payments/gateway/registry";
import { SandboxGateway, signSandboxWebhook } from "@/server/payments/gateway/sandbox";
import { merchantRefundIdFor } from "@/server/payments/intents";
import { merchantOrderIdFor } from "@/server/payments/intent-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

const cashfreeHeaders = (rawBody: string, secret: string, timestamp = String(Date.now())) =>
  new Headers({
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": createHmac("sha256", secret).update(timestamp + rawBody).digest("base64"),
  });

describe("payment intent state machine", () => {
  it("TC-B26-A-001 allows the forward path and refuses moving backwards or out of a terminal state", () => {
    expect(STATE_MACHINES.payment_intent).toBe(PAYMENT_INTENT_TRANSITIONS);
    expect(canMove("payment_intent", "CREATED", "PENDING")).toBe(true);
    expect(canMove("payment_intent", "PENDING", "CAPTURED")).toBe(true);
    expect(canMove("payment_intent", "CAPTURED", "PARTIALLY_REFUNDED")).toBe(true);
    expect(canMove("payment_intent", "PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
    expect(canMove("payment_intent", "PENDING", "EXPIRED")).toBe(true);
    // Illegal moves.
    expect(canMove("payment_intent", "CAPTURED", "FAILED")).toBe(false);
    expect(canMove("payment_intent", "FAILED", "CAPTURED")).toBe(false);
    expect(canMove("payment_intent", "EXPIRED", "PENDING")).toBe(false);
    expect(canMove("payment_intent", "REFUNDED", "CAPTURED")).toBe(false);
    expect(canMove("payment_intent", "PENDING", "REFUNDED")).toBe(false);
    for (const terminal of ["REFUNDED", "FAILED", "EXPIRED"] as const) expect(PAYMENT_INTENT_TRANSITIONS[terminal]).toEqual([]);
    expect(Object.keys(PAYMENT_INTENT_TRANSITIONS).sort()).toEqual([...PAYMENT_INTENT_STATUSES].sort());
  });
});

describe("registry", () => {
  it("TC-B26-A-002 chooses the sandbox by default and knows the four gateways", () => {
    expect(getPaymentGateway().name).toBe("SANDBOX");
    expect(getPaymentGateway().isConfigured()).toBe(true);
    expect(parseGatewayName("cashfree")).toBe("CASHFREE");
    expect(parseGatewayName("paypal")).toBeNull();
  });

  it("TC-B26-A-003 Razorpay and PhonePe report not configured without keys and refuse to call out", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const razorpay = new RazorpayGateway();
    const phonepe = new PhonePeGateway();
    expect(razorpay.isConfigured()).toBe(false);
    expect(phonepe.isConfigured()).toBe(false);
    await expect(razorpay.fetchOrder("order_x")).rejects.toThrow(/keys are not set/);
    await expect(phonepe.fetchOrder("tx")).rejects.toThrow(/keys are not set/);
    expect(razorpay.verifyWebhook("{}", new Headers({ "x-razorpay-signature": "x" }))).toBe(false);
    expect(phonepe.verifyWebhook('{"response":"e30="}', new Headers({ "x-verify": "x###1" }))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("TC-B26-A-004 merchant ids are gateway-safe and derived deterministically", () => {
    const id = merchantOrderIdFor("3f1c2b8e-0000-4000-8000-000000000001");
    expect(id).toMatch(/^gk_[0-9a-f]{32}$/);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(merchantRefundIdFor("refund:order:1")).toBe(merchantRefundIdFor("refund:order:1"));
    expect(merchantRefundIdFor("refund:order:1")).not.toBe(merchantRefundIdFor("refund:order:2"));
    expect(merchantRefundIdFor("k")).toMatch(/^gkrf_[0-9a-f]{32}$/);
  });
});

describe("sandbox signatures", () => {
  it("TC-B26-A-005 verifies its own HMAC and refuses a tampered body, a wrong signature or a stale timestamp", () => {
    const sandbox = new SandboxGateway();
    const body = JSON.stringify({ eventId: "e1", type: "PAYMENT_CAPTURED" });
    const signed = signSandboxWebhook(body);
    expect(sandbox.verifyWebhook(body, signed.headers)).toBe(true);
    expect(sandbox.verifyWebhook(body + " ", signed.headers)).toBe(false);
    const wrong = new Headers(signed.headers);
    wrong.set("x-sandbox-signature", "ab".repeat(32));
    expect(sandbox.verifyWebhook(body, wrong)).toBe(false);
    const stale = signSandboxWebhook(body, String(Date.now() - 6 * 60_000));
    expect(sandbox.verifyWebhook(body, stale.headers)).toBe(false);
    expect(sandbox.verifyWebhook(body, new Headers())).toBe(false);
    expect(isFresh(String(Math.floor(Date.now() / 1000)))).toBe(true);
    expect(isFresh("not-a-number")).toBe(false);
  });
});

describe("Cashfree adapter", () => {
  it("TC-B26-A-006 verifies x-webhook-signature (HMAC over timestamp + raw body) with a freshness window", () => {
    const cf = new CashfreeGateway();
    const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: "gk_1" } } });
    // tests/setup.ts sets CASHFREE_SECRET_KEY=test-webhook-secret.
    expect(cf.verifyWebhook(body, cashfreeHeaders(body, "test-webhook-secret"))).toBe(true);
    expect(cf.verifyWebhook(body, cashfreeHeaders(body, "another-secret"))).toBe(false);
    expect(cf.verifyWebhook(body, cashfreeHeaders(body, "test-webhook-secret", String(Date.now() - 10 * 60_000)))).toBe(false);
    expect(cf.verifyWebhook(body.replace("gk_1", "gk_2"), cashfreeHeaders(body, "test-webhook-secret"))).toBe(false);
  });

  it("TC-B26-A-007 parses payment and refund webhooks into gateway events", () => {
    const cf = new CashfreeGateway();
    const paid = cf.parseWebhook(
      JSON.stringify({
        type: "PAYMENT_SUCCESS_WEBHOOK",
        event_time: "2026-10-18T10:00:00+05:30",
        data: { order: { order_id: "gk_abc", order_amount: 140.5 }, payment: { cf_payment_id: 9911, payment_status: "SUCCESS", payment_amount: 140.5 } },
      }),
      new Headers({ "x-idempotency-key": "evt-1" }),
    );
    expect(paid).toMatchObject({ eventId: "evt-1", kind: "PAYMENT_CAPTURED", merchantRef: "gk_abc", gatewayOrderId: "gk_abc", gatewayPaymentId: "9911", amountPaise: 14050 });
    const refund = cf.parseWebhook(
      JSON.stringify({ type: "REFUND_STATUS_WEBHOOK", data: { refund: { cf_refund_id: 5, refund_id: "gkrf_1", order_id: "gk_abc", refund_status: "SUCCESS", refund_amount: 20 } } }),
      new Headers(),
    );
    expect(refund).toMatchObject({ kind: "REFUND_SUCCESS", merchantRef: "gkrf_1", gatewayRefundId: "5", amountPaise: 2000 });
    expect(refund.eventId).toMatch(/^REFUND_STATUS_WEBHOOK:5:SUCCESS:/);
  });

  it("TC-B26-A-008 maps Cashfree order + payments to our status", () => {
    const order = { order_id: "gk_1", order_status: "ACTIVE", order_amount: 100 };
    expect(mapCashfreeOrder({ ...order, order_status: "PAID" }, [{ cf_payment_id: 1, payment_status: "SUCCESS", payment_amount: 100, payment_group: "upi" }])).toMatchObject({
      status: "CAPTURED",
      amountPaise: 10_000,
      gatewayPaymentId: "1",
      method: "UPI",
    });
    expect(mapCashfreeOrder({ ...order, order_status: "EXPIRED" }, []).status).toBe("EXPIRED");
    expect(mapCashfreeOrder(order, [{ cf_payment_id: 2, payment_status: "FAILED", payment_message: "Declined", payment_group: "credit_card" }])).toMatchObject({
      status: "FAILED",
      failureReason: "Declined",
      method: "CARD",
    });
    expect(mapCashfreeOrder(order, []).status).toBe("PENDING");
  });

  it("TC-B26-A-009 creates a PG order with amount in rupees, return/notify URLs and methods, and refunds with our refund id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/orders")) return new Response(JSON.stringify({ order_id: "gk_1", order_status: "ACTIVE", order_amount: 70, payment_session_id: "sess_1" }));
        return new Response(JSON.stringify({ cf_refund_id: 77, refund_id: "gkrf_1", refund_status: "PENDING" }));
      }),
    );
    const cf = new CashfreeGateway();
    // Configured only with an app id + secret; tests/setup.ts clears CASHFREE_APP_ID, so set it here.
    const { getEnv } = await import("@/lib/env");
    const env = getEnv() as { CASHFREE_APP_ID?: string };
    const before = env.CASHFREE_APP_ID;
    env.CASHFREE_APP_ID = "test-app";
    try {
      const created = await cf.createOrder({
        merchantOrderId: "gk_1",
        amountPaise: 7000,
        customer: { id: "u1", email: "a@b.c", phone: "+919800000000" },
        returnUrl: "https://test.gokesari.com/orders/payment-return?intent=1",
        notifyUrl: "https://test.gokesari.com/api/webhooks/payments/cashfree",
        methods: ["UPI", "CARD"],
        description: "GoKesari order",
      });
      expect(created).toMatchObject({ gatewayOrderId: "gk_1", checkout: { kind: "SDK_SESSION", sessionToken: "sess_1" } });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body).toMatchObject({
        order_id: "gk_1",
        order_amount: 70,
        order_currency: "INR",
        customer_details: { customer_id: "u1", customer_phone: "9800000000" },
        order_meta: { payment_methods: "upi,cc,dc" },
      });
      expect((calls[0].init.headers as Record<string, string>)["x-api-version"]).toBe("2023-08-01");
      const refund = await cf.refund({ gatewayOrderId: "gk_1", gatewayPaymentId: "1", merchantRefundId: "gkrf_1", amountPaise: 2050, reason: "r" });
      expect(refund).toEqual({ gatewayRefundId: "77", status: "PENDING" });
      expect(calls[1].url).toMatch(/\/orders\/gk_1\/refunds$/);
      expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ refund_amount: 20.5, refund_id: "gkrf_1" });
    } finally {
      env.CASHFREE_APP_ID = before;
    }
  });
});

describe("Razorpay and PhonePe scaffolds", () => {
  it("TC-B26-A-010 Razorpay webhook signature is hex HMAC-SHA256 of the raw body; events parse", async () => {
    const { getEnv } = await import("@/lib/env");
    const env = getEnv() as unknown as Record<string, string | undefined>;
    const saved = { ...env };
    Object.assign(env, { RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "s", PAYMENT_WEBHOOK_SECRET_RAZORPAY: "whsec" });
    try {
      const rzp = new RazorpayGateway();
      expect(rzp.isConfigured()).toBe(true);
      const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 7000, notes: { merchantOrderId: "gk_1" } } } } });
      const sig = createHmac("sha256", "whsec").update(body).digest("hex");
      expect(rzp.verifyWebhook(body, new Headers({ "x-razorpay-signature": sig }))).toBe(true);
      expect(rzp.verifyWebhook(body, new Headers({ "x-razorpay-signature": sig.replace(/.$/, "0") }))).toBe(false);
      expect(rzp.parseWebhook(body, new Headers({ "x-razorpay-event-id": "evt_9" }))).toMatchObject({
        eventId: "evt_9",
        kind: "PAYMENT_CAPTURED",
        merchantRef: "gk_1",
        gatewayOrderId: "order_1",
        gatewayPaymentId: "pay_1",
        amountPaise: 7000,
      });
    } finally {
      for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "PAYMENT_WEBHOOK_SECRET_RAZORPAY"]) env[key] = saved[key];
    }
  });

  it("TC-B26-A-011 PhonePe callback X-VERIFY is sha256(response + salt)###index; the checksum for requests includes the path", async () => {
    const { getEnv } = await import("@/lib/env");
    const env = getEnv() as unknown as Record<string, string | undefined>;
    const saved = { ...env };
    Object.assign(env, { PHONEPE_MERCHANT_ID: "M1", PHONEPE_SALT_KEY: "salt", PHONEPE_SALT_INDEX: "1" });
    try {
      const pp = new PhonePeGateway();
      const inner = Buffer.from(JSON.stringify({ success: true, code: "PAYMENT_SUCCESS", data: { merchantTransactionId: "gk_1", transactionId: "T1", amount: 7000, state: "COMPLETED" } })).toString("base64");
      const body = JSON.stringify({ response: inner });
      const { createHash } = await import("node:crypto");
      const verify = `${createHash("sha256").update(inner + "salt").digest("hex")}###1`;
      expect(pp.verifyWebhook(body, new Headers({ "x-verify": verify }))).toBe(true);
      expect(pp.verifyWebhook(body, new Headers({ "x-verify": verify.replace("###1", "###2") }))).toBe(false);
      expect(pp.parseWebhook(body)).toMatchObject({ kind: "PAYMENT_CAPTURED", merchantRef: "gk_1", gatewayPaymentId: "T1", amountPaise: 7000 });
      expect(pp.checksum("abc", "/pg/v1/pay")).toBe(`${createHash("sha256").update("abc/pg/v1/paysalt").digest("hex")}###1`);
    } finally {
      for (const key of ["PHONEPE_MERCHANT_ID", "PHONEPE_SALT_KEY", "PHONEPE_SALT_INDEX"]) env[key] = saved[key];
    }
  });
});
