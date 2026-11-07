/**
 * Cashfree audit fixes (docs/payments-cashfree-audit-2026-11) that need no
 * database: the wrong-environment guard, Cashfree key kinds, payout transfer
 * ids, the WALLET payment method and the order helpers. fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cashfreeEnvProblem, cashfreeKeyKind, deployedSiteKind, getEnv, type ServerEnv } from "@/lib/env";
import { assertCashfreeEnvSafe, cashfreeOrderExpiry } from "@/server/payments/cashfree-env";
import { CashfreeGateway } from "@/server/payments/gateway/cashfree";
import { methodKind } from "@/server/payments/gateway/common";
import { cashfreePayoutProvider, cashfreeTransferId } from "@/server/payouts/providers/cashfree";

afterEach(() => vi.unstubAllGlobals());

/** A site's environment: production build on gokesari.com / test.gokesari.com, or a local one. */
function siteEnv(site: "production" | "test" | "local", extra: Partial<ServerEnv> = {}): ServerEnv {
  const base = getEnv();
  const host = site === "production" ? "https://gokesari.com" : site === "test" ? "https://test.gokesari.com" : "http://localhost:3000";
  return { ...base, NODE_ENV: site === "local" ? "development" : "production", AUTH_URL: host, ...extra } as ServerEnv;
}

describe("which site and which keys", () => {
  it("tells gokesari.com, the test site and local development apart", () => {
    expect(deployedSiteKind(siteEnv("production"))).toBe("production");
    expect(deployedSiteKind(siteEnv("production", { AUTH_URL: "https://www.gokesari.com" }))).toBe("production");
    expect(deployedSiteKind(siteEnv("test"))).toBe("test");
    expect(deployedSiteKind(siteEnv("local"))).toBe("local");
  });

  it("recognises Cashfree sandbox and production keys without needing their values", () => {
    expect(cashfreeKeyKind("TEST1012345", "cfsk_ma_test_abc")).toBe("sandbox");
    expect(cashfreeKeyKind("TEST1012345", undefined)).toBe("sandbox");
    expect(cashfreeKeyKind("1012345abc", "cfsk_ma_prod_abc")).toBe("production");
    expect(cashfreeKeyKind("1012345abc", "something")).toBe("unknown");
    expect(cashfreeKeyKind(undefined, undefined)).toBe("unknown");
  });
});

describe("never the sandbox on gokesari.com, never production on the test site", () => {
  it("payments", () => {
    expect(cashfreeEnvProblem("pg", siteEnv("production", { CASHFREE_ENV: "sandbox" }))).toMatch(/must be "production"/);
    expect(cashfreeEnvProblem("pg", siteEnv("production", { CASHFREE_ENV: "production", CASHFREE_APP_ID: "TEST123", CASHFREE_SECRET_KEY: "cfsk_ma_test_x" }))).toMatch(/Sandbox/);
    expect(cashfreeEnvProblem("pg", siteEnv("production", { CASHFREE_ENV: "production", CASHFREE_APP_ID: "123abc", CASHFREE_SECRET_KEY: "cfsk_ma_prod_x" }))).toBeNull();
    expect(cashfreeEnvProblem("pg", siteEnv("test", { CASHFREE_ENV: "production" }))).toMatch(/must be "sandbox"/);
    expect(cashfreeEnvProblem("pg", siteEnv("test", { CASHFREE_ENV: "sandbox", CASHFREE_SECRET_KEY: "cfsk_ma_prod_x" }))).toMatch(/Production Cashfree keys/);
    expect(cashfreeEnvProblem("pg", siteEnv("test", { CASHFREE_ENV: "sandbox", CASHFREE_APP_ID: "TEST1", CASHFREE_SECRET_KEY: "cfsk_ma_test_x" }))).toBeNull();
    // Local development and the test suite are never refused.
    expect(cashfreeEnvProblem("pg", siteEnv("local", { CASHFREE_ENV: "production" }))).toBeNull();
  });

  it("payouts and Secure ID", () => {
    expect(cashfreeEnvProblem("payouts", siteEnv("production", { CASHFREE_PAYOUT_ENV: "sandbox" }))).toMatch(/CASHFREE_PAYOUT_ENV/);
    expect(cashfreeEnvProblem("payouts", siteEnv("production", { CASHFREE_PAYOUT_ENV: "production" }))).toBeNull();
    expect(cashfreeEnvProblem("payouts", siteEnv("test", { CASHFREE_PAYOUT_ENV: "production" }))).toMatch(/test site/);
    expect(cashfreeEnvProblem("verification", siteEnv("production", { CASHFREE_ENV: "production", CASHFREE_VERIFICATION_ENV: "sandbox" }))).toMatch(/CASHFREE_VERIFICATION_ENV/);
    // Secure ID falls back to CASHFREE_ENV.
    expect(cashfreeEnvProblem("verification", siteEnv("production", { CASHFREE_ENV: "production", CASHFREE_VERIFICATION_ENV: undefined }))).toBeNull();
  });

  it("the order gateway counts as not configured, and a top-up / fee / ₹1 order is refused, on a mismatched site", () => {
    const env = getEnv() as unknown as Record<string, unknown>;
    const saved = { NODE_ENV: env.NODE_ENV, AUTH_URL: env.AUTH_URL, CASHFREE_APP_ID: env.CASHFREE_APP_ID, CASHFREE_ENV: env.CASHFREE_ENV, CASHFREE_PAYOUT_CLIENT_ID: env.CASHFREE_PAYOUT_CLIENT_ID, CASHFREE_PAYOUT_CLIENT_SECRET: env.CASHFREE_PAYOUT_CLIENT_SECRET, CASHFREE_PAYOUT_ENV: env.CASHFREE_PAYOUT_ENV };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      Object.assign(env, { NODE_ENV: "production", AUTH_URL: "https://gokesari.com", CASHFREE_APP_ID: "TEST123", CASHFREE_ENV: "sandbox", CASHFREE_PAYOUT_CLIENT_ID: "CF1", CASHFREE_PAYOUT_CLIENT_SECRET: "s", CASHFREE_PAYOUT_ENV: "sandbox" });
      expect(new CashfreeGateway().isConfigured()).toBe(false);
      expect(cashfreePayoutProvider.isConfigured()).toBe(false);
      expect(() => assertCashfreeEnvSafe("pg")).toThrow(/switched off on this site/);
      Object.assign(env, { CASHFREE_APP_ID: "123abc", CASHFREE_ENV: "production", CASHFREE_PAYOUT_ENV: "production" });
      expect(new CashfreeGateway().isConfigured()).toBe(true);
      expect(cashfreePayoutProvider.isConfigured()).toBe(true);
      expect(() => assertCashfreeEnvSafe("pg")).not.toThrow();
    } finally {
      Object.assign(env, saved);
      spy.mockRestore();
    }
  });
});

describe("Cashfree Payouts transfer_id", () => {
  it("keeps a short key as it is and gives every long key its own id of at most 40 characters", () => {
    expect(cashfreeTransferId("rider-transfer:abc:1")).toBe("rider_transfer_abc_1");
    const cycle = "3f1c9a52-7d1e-4f63-9b70-2b8e4f0c1d2a";
    const a = cashfreeTransferId(`payout-item:${cycle}:11111111-2222-4333-8444-555555555555:1`);
    const b = cashfreeTransferId(`payout-item:${cycle}:66666666-7777-4888-9999-000000000000:1`);
    const retry = cashfreeTransferId(`payout-item:${cycle}:11111111-2222-4333-8444-555555555555:2`);
    // Before the fix all three were "payout_item_3f1c9a52_7d1e_4f63_9b70_2b8".
    expect(new Set([a, b, retry]).size).toBe(3);
    for (const id of [a, b, retry]) {
      expect(id.length).toBeLessThanOrEqual(40);
      expect(id).toMatch(/^[A-Za-z0-9_]+$/);
    }
    // Same key, same id: Cashfree's idempotency holds for a resend of the same attempt.
    expect(cashfreeTransferId(`payout-item:${cycle}:11111111-2222-4333-8444-555555555555:1`)).toBe(a);
  });

  it("is what the transfer request carries", async () => {
    const env = getEnv() as unknown as Record<string, unknown>;
    const saved = { id: env.CASHFREE_PAYOUT_CLIENT_ID, secret: env.CASHFREE_PAYOUT_CLIENT_SECRET };
    const calls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ cf_transfer_id: "cft_1", status: "RECEIVED" }));
      }),
    );
    Object.assign(env, { CASHFREE_PAYOUT_CLIENT_ID: "CF1", CASHFREE_PAYOUT_CLIENT_SECRET: "s" });
    try {
      const key = "payout-item:3f1c9a52-7d1e-4f63-9b70-2b8e4f0c1d2a:11111111-2222-4333-8444-555555555555:1";
      await cashfreePayoutProvider.createTransfer({
        idempotencyKey: key,
        referenceId: "item-1",
        amountPaise: 12345,
        mode: "IMPS",
        beneficiary: { name: "Shop", method: "BANK_ACCOUNT", accountNumber: "1234567890", ifsc: "SBIN0001234" },
        narration: "GoKesari payout",
        attempt: 1,
      } as never);
      expect(calls[0].body.transfer_id).toBe(cashfreeTransferId(key));
    } finally {
      Object.assign(env, { CASHFREE_PAYOUT_CLIENT_ID: saved.id, CASHFREE_PAYOUT_CLIENT_SECRET: saved.secret });
    }
  });
});

describe("wallets (Paytm, PhonePe, Amazon Pay …) as a payment method", () => {
  it("maps Cashfree's wallet payment group, and sends WALLET as Cashfree's app method", async () => {
    expect(methodKind("wallet")).toBe("WALLET");
    expect(methodKind("app")).toBe("WALLET");
    expect(methodKind("credit_card")).toBe("CARD");
    const calls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ order_id: "gk_9", order_status: "ACTIVE", order_amount: 10, payment_session_id: "sess_9" }));
      }),
    );
    const env = getEnv() as { CASHFREE_APP_ID?: string };
    const before = env.CASHFREE_APP_ID;
    env.CASHFREE_APP_ID = "test-app";
    try {
      await new CashfreeGateway().createOrder({
        merchantOrderId: "gk_9",
        amountPaise: 1000,
        customer: { id: "u1", email: null, phone: null },
        returnUrl: "https://test.gokesari.com/r",
        notifyUrl: "https://test.gokesari.com/n",
        methods: ["UPI", "CARD", "NETBANKING", "WALLET"],
        description: "order",
      });
      expect(calls[0].body).toMatchObject({ order_meta: { payment_methods: "upi,cc,dc,nb,app" } });
    } finally {
      env.CASHFREE_APP_ID = before;
    }
  });
});

describe("order expiry", () => {
  it("is never less than Cashfree's 15-minute minimum", () => {
    const now = new Date("2026-11-07T10:00:00.000Z");
    expect(cashfreeOrderExpiry(60, now)).toBe("2026-11-07T11:00:00.000Z");
    expect(new Date(cashfreeOrderExpiry(1, now)).getTime() - now.getTime()).toBe(16 * 60_000);
  });
});

describe("Cashfree ids above 2^53 stay exact", () => {
  it("reads the digits from the raw body instead of the rounded number", async () => {
    const { exactJsonId } = await import("@/server/payments/gateway/common");
    // Seen on test.gokesari.com, 7 Nov 2026: Ref Id 1472617385555189760 was stored as …189800.
    const raw = '{"data":{"payment":{"cf_payment_id":1472617385555189760,"payment_status":"SUCCESS"}}}';
    const parsed = (JSON.parse(raw) as { data: { payment: { cf_payment_id: number } } }).data.payment.cf_payment_id;
    expect(String(parsed)).toBe("1472617385555189800");
    expect(exactJsonId(raw, "cf_payment_id", parsed)).toBe("1472617385555189760");
    // Strings, small numbers and nothing are taken as they are.
    expect(exactJsonId('{"cf_payment_id":"1472617385555189760"}', "cf_payment_id", "1472617385555189760")).toBe("1472617385555189760");
    expect(exactJsonId('{"cf_refund_id":1319966828}', "cf_refund_id", 1319966828)).toBe("1319966828");
    expect(exactJsonId("{}", "cf_payment_id", undefined)).toBeNull();
    // Another id in the same body is never picked up: only digits equal to the parsed number count.
    const two = '{"refund":{"cf_payment_id":1472617376889757696},"payment":{"cf_payment_id":1472617408803090944}}';
    const second = (JSON.parse(two) as { payment: { cf_payment_id: number } }).payment.cf_payment_id;
    expect(exactJsonId(two, "cf_payment_id", second)).toBe("1472617408803090944");
  });

  it("the order-gateway adapter's webhook event carries the exact payment id", () => {
    const raw = '{"type":"PAYMENT_SUCCESS_WEBHOOK","event_time":"2026-11-07T21:05:51+05:30","data":{"order":{"order_id":"gk_1","order_amount":100},"payment":{"cf_payment_id":1472617385555189760,"payment_status":"SUCCESS","payment_amount":100}}}';
    const event = new CashfreeGateway().parseWebhook(raw, new Headers());
    expect(event.gatewayPaymentId).toBe("1472617385555189760");
    expect(event.eventId).toContain("1472617385555189760");
  });
});
