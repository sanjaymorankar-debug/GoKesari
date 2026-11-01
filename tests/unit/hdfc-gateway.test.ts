/**
 * HDFC Bank SmartGateway adapter (no network: fetch is stubbed) and the
 * return route that forwards the customer to our own page. All keys here are fakes.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as returnGet, POST as returnPost } from "@/app/api/payments/hdfc/return/route";
import { getEnv } from "@/lib/env";
import { HdfcGateway, hdfcOrderId, hdfcOrderStatus, hdfcReturnUrl, verifyReturnSignature } from "@/server/payments/gateway/hdfc";
import { getGatewayByName, parseGatewayName } from "@/server/payments/gateway/registry";

const KEYS = {
  HDFC_BASE_URL: "https://smartgateway.example.test",
  HDFC_MERCHANT_ID: "MTEST1",
  HDFC_API_KEY: "fake-api-key",
  HDFC_PAYMENT_PAGE_CLIENT_ID: "fakeclient",
  HDFC_RESPONSE_KEY: "fake-response-key",
  HDFC_WEBHOOK_USERNAME: "hook",
  HDFC_WEBHOOK_PASSWORD: "hook-pass",
  PAYMENT_PUBLIC_BASE_URL: "https://test.gokesari.com",
};

const env = getEnv() as unknown as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

function setKeys(extra: Record<string, string | undefined> = {}) {
  Object.assign(env, KEYS, extra);
}

beforeEach(() => {
  saved = { ...env };
});

afterEach(() => {
  for (const key of Object.keys(env)) if (!(key in saved)) delete env[key];
  Object.assign(env, saved);
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("HDFC SmartGateway adapter", () => {
  it("is a known gateway, not configured without keys, and never calls out then", async () => {
    expect(parseGatewayName("hdfc")).toBe("HDFC");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const hdfc = getGatewayByName("HDFC");
    expect(hdfc.isConfigured()).toBe(false);
    await expect(hdfc.fetchOrder("GK1")).rejects.toThrow(/keys are not set/);
    expect(hdfc.verifyWebhook("{}", new Headers({ authorization: basic("hook", "hook-pass") }))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a UAT base URL on gokesari.com", () => {
    setKeys({ HDFC_BASE_URL: "https://smartgateway.hdfcuat.bank.in" });
    const hdfc = new HdfcGateway();
    expect(hdfc.isConfigured()).toBe(true);
    Object.assign(env, { NODE_ENV: "production", AUTH_URL: "https://test.gokesari.com" });
    expect(hdfc.isConfigured()).toBe(true);
    Object.assign(env, { AUTH_URL: "https://gokesari.com" });
    expect(hdfc.isConfigured()).toBe(false);
    Object.assign(env, { HDFC_BASE_URL: "https://smartgateway.example.test" });
    expect(hdfc.isConfigured()).toBe(true);
  });

  it("derives a short, stable order id the bank accepts", () => {
    const id = hdfcOrderId("gk_0123456789abcdef0123456789abcdef");
    expect(id).toMatch(/^GK[0-9A-F]{18}$/);
    expect(id.length).toBeLessThan(21);
    expect(hdfcOrderId("gk_0123456789abcdef0123456789abcdef")).toBe(id);
    expect(hdfcOrderId("gk_other")).not.toBe(id);
  });

  it("maps order statuses", () => {
    expect(hdfcOrderStatus("CHARGED")).toBe("CAPTURED");
    expect(hdfcOrderStatus("AUTHORIZED")).toBe("AUTHORIZED");
    for (const s of ["AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "JUSPAY_DECLINED", "AUTO_REFUNDED"]) expect(hdfcOrderStatus(s)).toBe("FAILED");
    for (const s of ["NEW", "STARTED", "PENDING_VBV", "AUTHORIZING", "PARTIAL_CHARGED", "SOMETHING_NEW"]) expect(hdfcOrderStatus(s)).toBe("PENDING");
  });

  it("opens a payment-page session with Basic auth and returns the hosted URL", async () => {
    setKeys();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ status: "NEW", id: "ordeh_1", order_id: hdfcOrderId("gk_abc"), payment_links: { web: "https://pay.example.test/p/1", expiry: "2026-10-30T10:15:00Z" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const order = await new HdfcGateway().createOrder({
      merchantOrderId: "gk_abc",
      amountPaise: 12345,
      customer: { id: "8f2c1d7e-0000-4000-8000-000000000001", email: "c@example.test", phone: "9999999999", name: "Test" },
      returnUrl: "https://test.gokesari.com/orders/payment-return?intent=8f2c1d7e-0000-4000-8000-000000000001",
      notifyUrl: "https://test.gokesari.com/api/webhooks/payments/hdfc",
      description: "Order",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect(order.checkout).toEqual({ kind: "HOSTED_URL", url: "https://pay.example.test/p/1" });
    expect(order.status).toBe("PENDING");
    expect(order.expiresAt?.toISOString()).toBe("2026-10-30T10:15:00.000Z");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://smartgateway.example.test/session");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("fake-api-key:").toString("base64")}`);
    expect(headers["x-merchantid"]).toBe("MTEST1");
    expect(headers["x-customerid"]).toBe("8f2c1d7e-0000-4000-8000-000000000001");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      order_id: hdfcOrderId("gk_abc"),
      amount: "123.45",
      currency: "INR",
      payment_page_client_id: "fakeclient",
      action: "paymentPage",
      customer_email: "c@example.test",
      "metadata.expiryInMins": "15",
    });
    expect(body.return_url).toBe(
      `https://test.gokesari.com/api/payments/hdfc/return?to=${encodeURIComponent("/orders/payment-return?intent=8f2c1d7e-0000-4000-8000-000000000001")}`,
    );
  });

  it("reads the order from the API: amount in rupees → paise, method, failure reason", async () => {
    setKeys();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse({ order_id: "GK1", status: "CHARGED", amount: 70.5, txn_id: "MTEST1-GK1-1", payment_method_type: "UPI" }))
        .mockResolvedValueOnce(jsonResponse({ order_id: "GK2", status: "AUTHORIZATION_FAILED", amount: 10, bank_error_message: "Insufficient funds", payment_method_type: "CARD" })),
    );
    const hdfc = new HdfcGateway();
    expect(await hdfc.fetchOrder("GK1")).toEqual({
      gatewayOrderId: "GK1",
      status: "CAPTURED",
      amountPaise: 7050,
      gatewayPaymentId: "MTEST1-GK1-1",
      method: "UPI",
      failureReason: null,
    });
    expect(await hdfc.fetchOrder("GK2")).toMatchObject({ status: "FAILED", method: "CARD", failureReason: "Insufficient funds" });
  });

  it("refunds with a form body keyed by our refund id and reads the refund back", async () => {
    setKeys();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ order_id: "GK1", status: "CHARGED", refunds: [{ unique_request_id: "rf_1", status: "PENDING", id: "R1" }] }))
      .mockResolvedValueOnce(jsonResponse({ order_id: "GK1", status: "CHARGED", refunds: [{ unique_request_id: "rf_1", status: "SUCCESS", id: "R1" }] }));
    vi.stubGlobal("fetch", fetchSpy);
    const hdfc = new HdfcGateway();
    expect(await hdfc.refund({ gatewayOrderId: "GK1", gatewayPaymentId: null, merchantRefundId: "rf_1", amountPaise: 2500, reason: "cancel" })).toEqual({
      gatewayRefundId: "R1",
      status: "PENDING",
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://smartgateway.example.test/orders/GK1/refunds");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe("unique_request_id=rf_1&amount=25.00");
    expect(await hdfc.fetchRefund("GK1", "rf_1")).toEqual({ gatewayRefundId: "R1", status: "SUCCESS" });
  });

  it("accepts a webhook only with the right Basic auth and parses order and refund events", () => {
    setKeys();
    const hdfc = new HdfcGateway();
    const paid = JSON.stringify({ id: "evt_1", date_created: "2026-10-30T10:00:00Z", event_name: "ORDER_SUCCEEDED", content: { order: { order_id: "GK1", status: "CHARGED", amount: 70, txn_id: "T1" } } });
    expect(hdfc.verifyWebhook(paid, new Headers({ authorization: basic("hook", "hook-pass") }))).toBe(true);
    expect(hdfc.verifyWebhook(paid, new Headers({ authorization: basic("hook", "wrong") }))).toBe(false);
    expect(hdfc.verifyWebhook(paid, new Headers())).toBe(false);
    expect(hdfc.parseWebhook(paid)).toMatchObject({
      eventId: "evt_1",
      kind: "PAYMENT_CAPTURED",
      merchantRef: null,
      gatewayOrderId: "GK1",
      gatewayPaymentId: "T1",
      amountPaise: 7000,
    });

    const refunded = JSON.stringify({
      id: "evt_2",
      event_name: "ORDER_REFUNDED",
      content: { order: { order_id: "GK1", status: "CHARGED", refunds: [{ unique_request_id: "rf_0", status: "SUCCESS", amount: 5 }, { unique_request_id: "rf_1", status: "SUCCESS", id: "R1", amount: 25 }] } },
    });
    expect(hdfc.parseWebhook(refunded)).toMatchObject({ kind: "REFUND_SUCCESS", merchantRef: "rf_1", gatewayRefundId: "R1", amountPaise: 2500 });
  });

  it("checks the return signature the way HDFC's kit computes it", () => {
    const params: Record<string, string> = { order_id: "GK1", status: "CHARGED", status_id: "21" };
    const pairs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort();
    const signature = createHmac("sha256", "fake-response-key").update(encodeURIComponent(pairs.join("&"))).digest("base64");
    expect(verifyReturnSignature({ ...params, signature, signature_algorithm: "HMAC-SHA256" }, "fake-response-key")).toBe(true);
    expect(verifyReturnSignature({ ...params, signature: encodeURIComponent(signature) }, "fake-response-key")).toBe(true);
    expect(verifyReturnSignature({ ...params, status: "FAILED", signature }, "fake-response-key")).toBe(false);
    expect(verifyReturnSignature({ ...params, signature }, undefined)).toBe(false);
  });
});

describe("HDFC return route", () => {
  it("builds the return URL on our own origin only", () => {
    setKeys();
    expect(hdfcReturnUrl("https://evil.example/x")).toBe("https://test.gokesari.com/api/payments/hdfc/return?to=%2F");
    expect(hdfcReturnUrl(undefined)).toBe("https://test.gokesari.com/api/payments/hdfc/return?to=%2F");
  });

  it("forwards GET and POST returns (303) to our page and never to another host", async () => {
    setKeys();
    const to = encodeURIComponent("/orders/payment-return?intent=abc");
    const get = await returnGet(new NextRequest(`https://test.gokesari.com/api/payments/hdfc/return?to=${to}&order_id=GK1&status=CHARGED`));
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("https://test.gokesari.com/orders/payment-return?intent=abc");

    const post = await returnPost(
      new NextRequest(`https://test.gokesari.com/api/payments/hdfc/return?to=${to}`, {
        method: "POST",
        body: new URLSearchParams({ order_id: "GK1", status: "CHARGED" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("https://test.gokesari.com/orders/payment-return?intent=abc");

    for (const bad of ["//evil.example/x", "https://evil.example/x", "/\\evil.example"]) {
      const res = await returnGet(new NextRequest(`https://test.gokesari.com/api/payments/hdfc/return?to=${encodeURIComponent(bad)}`));
      expect(res.headers.get("location")).toBe("https://test.gokesari.com/");
    }
  });
});
