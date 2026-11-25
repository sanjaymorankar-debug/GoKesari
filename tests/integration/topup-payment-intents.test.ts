/**
 * PAY-2 (docs/payments-topups-via-intents-2026-11): wallet top-ups and shop
 * wallet recharges through payment intents, behind rule topupPaymentIntents.
 *
 *  - rule off (default): the older top-up flow, unchanged;
 *  - rule on: one create path (payment intent), one webhook (/api/webhooks/payments/<gateway>),
 *    one status lookup (reconcileIntent via /api/wallet/verify);
 *  - the older webhook URL (/api/webhooks/cashfree) forwards a routed top-up to the one
 *    webhook, and still settles a top-up started on the older flow before the switch.
 */
import { createHmac } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as legacyWebhookRoute } from "@/app/api/webhooks/cashfree/route";
import { POST as webhookRoute } from "@/app/api/webhooks/payments/[gateway]/route";
import { db } from "@/server/db";
import {
  domainEvents,
  paymentIntents,
  paymentWebhookEvents,
  payments,
  platformSettings,
  shopWallets,
  walletTransactions,
  wallets,
  type PaymentIntentRow,
} from "@/server/db/schema";
import { CashfreeGateway } from "@/server/payments/gateway/cashfree";
import { getGatewayByName, setGatewayOverrideForTests } from "@/server/payments/gateway/registry";
import type { SandboxGateway } from "@/server/payments/gateway/sandbox";
import type { GatewayOrderState } from "@/server/payments/gateway/types";
import { applyGatewayState, runPaymentReconciliation } from "@/server/payments/processing";
import {
  createShopWalletTopUpOrder,
  createTopUpOrder,
  verifyAndCreditTopUp,
  verifyShopWalletTopUp,
} from "@/server/services/payments";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, createUserWithWallet, resetDatabase } from "../helpers/fixtures";

const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
const RULE_KEYS = ["topupPaymentIntents", "shopWallet", "onlinePayments"];

async function clearRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, RULE_KEYS));
  clearRuleCache();
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE TABLE payment_webhook_events, payment_refunds, payment_intent_events, payment_intents, payment_sandbox_orders CASCADE`);
  await clearRules();
});

afterEach(async () => {
  setGatewayOverrideForTests("CASHFREE", null);
  await clearRules();
});

async function routingOn() {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("topupPaymentIntents", { enabled: true }, { id: admin.id, role: "ADMIN" });
  return admin;
}

const balanceOf = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const paymentOf = async (id: string) => (await db.query.payments.findFirst({ where: eq(payments.id, id) }))!;
const intentFor = async (paymentId: string) =>
  (await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.referenceId, paymentId) })) as PaymentIntentRow | undefined;
const topUpTxns = (paymentId: string) =>
  db.select().from(walletTransactions).where(and(eq(walletTransactions.paymentId, paymentId), eq(walletTransactions.type, "TOP_UP")));

async function postNewWebhook(gateway: string, rawBody: string, headers: Headers) {
  const request = new NextRequest(`http://localhost/api/webhooks/payments/${gateway}`, { method: "POST", body: rawBody, headers });
  const response = await webhookRoute(request, { params: Promise.resolve({ gateway }) });
  return { status: response.status, body: await response.json() };
}

/** A Cashfree delivery to the OLD URL, signed the way Cashfree signs (base64 HMAC over timestamp + body). */
async function postLegacyWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", process.env.CASHFREE_SECRET_KEY!).update(timestamp + raw).digest("base64");
  const response = await legacyWebhookRoute(
    new NextRequest("http://localhost/api/webhooks/cashfree", {
      method: "POST",
      body: raw,
      headers: { "x-webhook-signature": signature, "x-webhook-timestamp": timestamp, "content-type": "application/json" },
    }),
  );
  return { status: response.status, body: await response.json() };
}

function successEvent(orderId: string, cfPaymentId: string, rupees: number) {
  return {
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: {
      order: { order_id: orderId, order_amount: rupees, order_currency: "INR" },
      payment: { cf_payment_id: cfPaymentId, payment_status: "SUCCESS", payment_amount: rupees, payment_currency: "INR" },
    },
  };
}

/** Cashfree as the intent gateway, answering from a table instead of the network. */
class FakeCashfree extends CashfreeGateway {
  readonly orders = new Map<string, GatewayOrderState>();
  isConfigured(): boolean {
    return true;
  }
  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    return this.orders.get(gatewayOrderId) ?? { gatewayOrderId, status: "PENDING", amountPaise: 0, gatewayPaymentId: null, method: null };
  }
}

/** A routed top-up whose intent lives at (fake) Cashfree: opened on the sandbox, then moved, as a Cashfree one would be. */
async function cashfreeRoutedTopUp(userId: string, amountPaise: number) {
  const fake = new FakeCashfree();
  setGatewayOverrideForTests("CASHFREE", fake);
  const started = await createTopUpOrder(userId, amountPaise);
  const intent = (await intentFor(started.payment.id))!;
  await db.update(paymentIntents).set({ gateway: "CASHFREE", gatewayOrderId: intent.merchantOrderId }).where(eq(paymentIntents.id, intent.id));
  return { fake, started, intent: { ...intent, gateway: "CASHFREE" as const, gatewayOrderId: intent.merchantOrderId } };
}

describe("rule topupPaymentIntents off (default)", () => {
  it("keeps the older top-up flow: no intent, no redirect", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 50_000);
    expect(started.payment.gateway).toBe("MOCK");
    expect(started.mock).toBe(true);
    expect(started.redirectUrl).toBeNull();
    expect(await intentFor(started.payment.id)).toBeUndefined();
  });
});

describe("rule on: top-ups through payment intents", () => {
  it("opens a payments row + a WALLET_TOPUP intent and moves no money", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 50_000);

    const intent = (await intentFor(started.payment.id))!;
    expect(intent).toMatchObject({ purpose: "WALLET_TOPUP", amountPaise: 50_000, userId: user.id, status: "PENDING", gateway: "SANDBOX" });
    expect(started.payment).toMatchObject({ gateway: "INTENT", status: "CREATED", gatewayOrderId: intent.merchantOrderId });
    expect(started.mock).toBe(false);
    expect(started.paymentSessionId).toBeNull();
    expect(started.redirectUrl).toContain(intent.merchantOrderId); // the sandbox's hosted page
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("credits once through the one webhook; a redelivery and the status check change nothing", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 50_000);
    const intent = (await intentFor(started.payment.id))!;

    const webhook = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
    expect((await postNewWebhook("sandbox", webhook.rawBody, webhook.headers)).status).toBe(200);
    expect(await balanceOf(user.id)).toBe(50_000);
    expect((await paymentOf(started.payment.id)).status).toBe("SUCCESS");
    expect((await intentFor(started.payment.id))!.status).toBe("CAPTURED");

    const again = await postNewWebhook("sandbox", webhook.rawBody, webhook.headers);
    expect(again.body).toMatchObject({ duplicate: true });
    const verified = await verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: started.gatewayOrderId });
    expect(verified).toMatchObject({ alreadyProcessed: true, balancePaise: 50_000 });
    expect(await balanceOf(user.id)).toBe(50_000);
    expect(await topUpTxns(started.payment.id)).toHaveLength(1);
  });

  it("the status check alone credits a paid top-up whose webhook never came", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 25_000);
    const intent = (await intentFor(started.payment.id))!;
    await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "CARD"); // paid at the gateway; webhook not delivered

    const verified = await verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: started.gatewayOrderId });
    expect(verified).toMatchObject({ alreadyProcessed: false, balancePaise: 25_000 });
    expect(await topUpTxns(started.payment.id)).toHaveLength(1);
  });

  it("refuses someone else's top-up and says 'not confirmed yet' while unpaid", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const { user: other } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 25_000);

    await expect(verifyAndCreditTopUp({ userId: other.id, gatewayOrderId: started.gatewayOrderId })).rejects.toMatchObject({
      code: "PAYMENT_VERIFICATION_FAILED",
    });
    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: started.gatewayOrderId })).rejects.toMatchObject({
      code: "PAYMENT_VERIFICATION_FAILED",
    });
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("a failed payment fails the payments row and credits nothing", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 25_000);
    const intent = (await intentFor(started.payment.id))!;
    const webhook = await sandbox.simulate(intent.gatewayOrderId!, "FAILURE", "UPI");
    await postNewWebhook("sandbox", webhook.rawBody, webhook.headers);

    expect((await paymentOf(started.payment.id)).status).toBe("FAILED");
    await expect(verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: started.gatewayOrderId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("money taken after the attempt ended is still credited (once)", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 25_000);
    const intent = (await intentFor(started.payment.id))!;
    await applyGatewayState(intent.id, { gatewayOrderId: intent.gatewayOrderId!, status: "EXPIRED", amountPaise: 25_000, gatewayPaymentId: null, method: null }, { source: "RECONCILE" });
    expect((await paymentOf(started.payment.id)).status).toBe("FAILED");

    const late: GatewayOrderState = { gatewayOrderId: intent.gatewayOrderId!, status: "CAPTURED", amountPaise: 25_000, gatewayPaymentId: "late_pay_1", method: "UPI" };
    expect((await applyGatewayState(intent.id, late, { source: "WEBHOOK" })).outcome).toBe("LATE_CAPTURE");
    expect((await applyGatewayState(intent.id, late, { source: "RECONCILE" })).outcome).toBe("LATE_CAPTURE");
    expect(await balanceOf(user.id)).toBe(25_000);
    expect(await paymentOf(started.payment.id)).toMatchObject({ status: "SUCCESS", gatewayPaymentId: "late_pay_1" });
    expect(await topUpTxns(started.payment.id)).toHaveLength(1);
    // Handled, so support is not alerted about it.
    const alerts = await db.select().from(domainEvents).where(eq(domainEvents.type, "payment.attention"));
    expect(alerts).toHaveLength(0);
  });

  it("the reconciliation job settles a routed top-up with the other intents", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const started = await createTopUpOrder(user.id, 30_000);
    const intent = (await intentFor(started.payment.id))!;
    await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
    await db.update(paymentIntents).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(paymentIntents.id, intent.id));

    const result = await runPaymentReconciliation();
    expect(result.moved).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(user.id)).toBe(30_000);
  });

  it("a shop wallet recharge credits the shop's wallet, not the owner's", async () => {
    const admin = await routingOn();
    await setRule("shopWallet", { enabled: true }, { id: admin.id, role: "ADMIN" });
    const { user: owner } = await createUserWithWallet({ balancePaise: 0, role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const started = await createShopWalletTopUpOrder(shop.id, owner.id, 20_000);
    const intent = (await intentFor(started.payment.id))!;
    expect(intent.purpose).toBe("SHOP_WALLET_TOPUP");

    await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
    const verified = await verifyShopWalletTopUp({ userId: owner.id, shopId: shop.id, gatewayOrderId: started.gatewayOrderId });
    expect(verified.balancePaise).toBe(20_000);
    expect((await db.query.shopWallets.findFirst({ where: eq(shopWallets.shopId, shop.id) }))!.balancePaise).toBe(20_000);
    expect(await balanceOf(owner.id)).toBe(0);
  });
});

describe("the older webhook URL (/api/webhooks/cashfree)", () => {
  it("forwards a routed top-up to the one payment webhook, which credits it once", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const { fake, started, intent } = await cashfreeRoutedTopUp(user.id, 40_000);
    fake.orders.set(intent.gatewayOrderId, { gatewayOrderId: intent.gatewayOrderId, status: "CAPTURED", amountPaise: 40_000, gatewayPaymentId: "5114917039291", method: "UPI" });

    const event = successEvent(intent.gatewayOrderId, "5114917039291", 400);
    const first = await postLegacyWebhook(event);
    expect(first).toMatchObject({ status: 200, body: { received: true, outcome: "MOVED" } });
    expect(await balanceOf(user.id)).toBe(40_000);
    expect(await paymentOf(started.payment.id)).toMatchObject({ status: "SUCCESS", gatewayPaymentId: "5114917039291" });

    // Recorded by the one webhook pipeline, under the Cashfree gateway.
    const recorded = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.gateway, "CASHFREE"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ intentId: intent.id, outcome: "MOVED" });

    // The same delivery again (to either URL) changes nothing.
    expect((await postLegacyWebhook(event)).status).toBe(200);
    expect(await balanceOf(user.id)).toBe(40_000);
    expect(await topUpTxns(started.payment.id)).toHaveLength(1);
  });

  it("the forwarded event is only a trigger: an unpaid order at Cashfree credits nothing", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const { started, intent } = await cashfreeRoutedTopUp(user.id, 40_000);
    // No state set at (fake) Cashfree: still PENDING whatever the body claims.
    const response = await postLegacyWebhook(successEvent(intent.gatewayOrderId, "999", 400));
    expect(response.status).toBe(200);
    expect(await balanceOf(user.id)).toBe(0);
    expect((await paymentOf(started.payment.id)).status).toBe("CREATED");
  });

  it("refuses a forged delivery before forwarding anything", async () => {
    await routingOn();
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const { intent } = await cashfreeRoutedTopUp(user.id, 40_000);
    const raw = JSON.stringify(successEvent(intent.gatewayOrderId, "1", 400));
    const response = await legacyWebhookRoute(
      new NextRequest("http://localhost/api/webhooks/cashfree", {
        method: "POST",
        body: raw,
        headers: { "x-webhook-signature": "forged", "x-webhook-timestamp": String(Date.now()) },
      }),
    );
    expect(response.status).toBe(400);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("still settles a top-up started on the older flow before the switch-over", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const inFlight = await createTopUpOrder(user.id, 15_000); // rule off: the older flow
    await routingOn(); // switched on while it is in flight

    const response = await postLegacyWebhook(successEvent(inFlight.gatewayOrderId, "cf_legacy_1", 150));
    expect(response.status).toBe(200);
    expect(await balanceOf(user.id)).toBe(15_000);
    expect(await paymentOf(inFlight.payment.id)).toMatchObject({ status: "SUCCESS", gateway: "MOCK" });
    expect(await intentFor(inFlight.payment.id)).toBeUndefined();
  });
});
