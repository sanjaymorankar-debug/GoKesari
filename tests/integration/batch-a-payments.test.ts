/**
 * batch-2026-10 WS-A — direct online payment (F1.7.3 / F1.8.4, GS-028, NEW-007,
 * SM-005, GS-073) against the sandbox gateway and a real PostgreSQL.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { NextRequest } from "next/server";

import { POST as checkoutRoute } from "@/app/api/checkout/route";
import { POST as payRoute } from "@/app/api/orders/[id]/pay/route";
import { GET as intentRoute } from "@/app/api/payments/intents/[id]/route";
import { POST as reconcileRoute } from "@/app/api/cron/payments-reconcile/route";
import { POST as webhookRoute } from "@/app/api/webhooks/payments/[gateway]/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  domainEvents,
  notifications,
  orders,
  paymentIntentEvents,
  paymentIntents,
  paymentRefunds,
  paymentSandboxOrders,
  paymentWebhookEvents,
  platformSettings,
  shopProducts,
  wallets,
} from "@/server/db/schema";
import { getGatewayByName, setGatewayOverrideForTests } from "@/server/payments/gateway/registry";
import { SandboxGateway, sandboxSettings, signSandboxWebhook } from "@/server/payments/gateway/sandbox";
import type { GatewayOrderState, PaymentGateway } from "@/server/payments/gateway/types";
import { createPaymentIntent, findCapturedIntent, getPaymentIntent, refundPaymentIntent } from "@/server/payments/intents";
import { retryOrderPayment, startOnlineCheckout } from "@/server/payments/order-payments";
import { applyGatewayState, handlePaymentWebhook, runPaymentReconciliation } from "@/server/payments/processing";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { addToCart } from "@/server/services/cart";
import { cancelOrder, checkout } from "@/server/services/orders";
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

const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
let seq = 0;

async function cleanPaymentTables() {
  await db.execute(sql`TRUNCATE TABLE payment_webhook_events, payment_refunds, payment_intent_events, payment_intents, payment_sandbox_orders CASCADE`);
}

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["onlinePayments", "otp", "otpHousekeeping"]));
  clearRuleCache();
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  sandboxSettings.refundMode = "SUCCESS";
  await resetDatabase();
  await cleanPaymentTables();
  await clearMyRules();
});

afterEach(async () => {
  setGatewayOverrideForTests("SANDBOX", null);
  await clearMyRules();
});

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function setup(options: { stock?: number; shops?: number; balancePaise?: number } = {}) {
  const admin = await createUser({ role: "ADMIN" });
  const { user: customer } = await createUserWithWallet({ balancePaise: options.balancePaise ?? 0 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shops = [];
  const listings = [];
  for (let i = 0; i < (options.shops ?? 1); i++) {
    const shop = await createShop(owner.id, { name: `Dairy ${i + 1}` });
    shops.push(shop);
    listings.push(await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: options.stock ?? 10 }));
  }
  const addressId = await deliveryAddressId(customer.id);
  return { admin, customer, owner, shops, listings, addressId };
}

async function onlinePaymentsOn(admin: { id: string; role: UserRole }, extra: Record<string, unknown> = {}) {
  await setRule("onlinePayments", { enabled: true, ...extra }, admin);
}

const stockOf = async (id: string) => (await db.query.shopProducts.findFirst({ where: eq(shopProducts.id, id) }))!.onlineStock;
const orderOf = async (id: string) => (await db.query.orders.findFirst({ where: eq(orders.id, id) }))!;
const intentRow = async (id: string) => (await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) }))!;

async function placeOnline(s: Awaited<ReturnType<typeof setup>>, requestId = `req-online-${++seq}`) {
  for (const listing of s.listings) await addToCart(s.customer.id, listing.id, 2);
  return startOnlineCheckout({ userId: s.customer.id, addressId: s.addressId, requestId });
}

async function postWebhook(gateway: string, rawBody: string, headers: Headers) {
  const request = new NextRequest(`http://localhost/api/webhooks/payments/${gateway}`, { method: "POST", body: rawBody, headers });
  const response = await webhookRoute(request, { params: Promise.resolve({ gateway }) });
  return { status: response.status, body: await response.json() };
}

/** The sandbox page's "Pay" / "Fail" / "Let it expire", posted as a signed webhook through the route. */
async function payAtSandbox(intentId: string, outcome: "SUCCESS" | "FAILURE" | "EXPIRE") {
  const intent = await intentRow(intentId);
  const webhook = await sandbox.simulate(intent.gatewayOrderId!, outcome, "UPI");
  return postWebhook("sandbox", webhook.rawBody, webhook.headers);
}

/* ------------------------------------------------------------ sandbox */

describe("sandbox gateway", () => {
  it("TC-B26-A-020 creates an order idempotently, reports it, and refunds within the captured amount", async () => {
    const input = {
      merchantOrderId: "gk_test_sandbox_1",
      amountPaise: 15_000,
      customer: { id: "c1" },
      returnUrl: "http://localhost/r",
      notifyUrl: "http://localhost/w",
      description: "Test",
    };
    const first = await sandbox.createOrder(input);
    const again = await sandbox.createOrder(input);
    expect(again.gatewayOrderId).toBe(first.gatewayOrderId);
    expect(first.checkout).toEqual({ kind: "HOSTED_URL", url: "/orders/pay/sandbox/gk_test_sandbox_1" });
    expect((await sandbox.fetchOrder(first.gatewayOrderId)).status).toBe("CREATED");

    await sandbox.simulate(first.gatewayOrderId, "SUCCESS", "CARD");
    const paid = await sandbox.fetchOrder(first.gatewayOrderId);
    expect(paid).toMatchObject({ status: "CAPTURED", amountPaise: 15_000, method: "CARD" });
    expect(paid.gatewayPaymentId).toMatch(/^sbxpay_/);

    const refund = await sandbox.refund({ gatewayOrderId: first.gatewayOrderId, gatewayPaymentId: paid.gatewayPaymentId, merchantRefundId: "rf1", amountPaise: 5000, reason: "x" });
    expect(refund.status).toBe("SUCCESS");
    // Idempotent on the merchant refund id.
    expect((await sandbox.refund({ gatewayOrderId: first.gatewayOrderId, gatewayPaymentId: null, merchantRefundId: "rf1", amountPaise: 5000, reason: "x" })).gatewayRefundId).toBe(refund.gatewayRefundId);
    await expect(sandbox.refund({ gatewayOrderId: first.gatewayOrderId, gatewayPaymentId: null, merchantRefundId: "rf2", amountPaise: 10_001, reason: "x" })).rejects.toThrow(/more than/);
    expect((await sandbox.fetchRefund(first.gatewayOrderId, "rf1")).status).toBe("SUCCESS");
  });

  it("TC-B26-A-021 expires an unpaid order after its expiry time", async () => {
    const order = await sandbox.createOrder({
      merchantOrderId: "gk_test_sandbox_2",
      amountPaise: 1000,
      customer: { id: "c1" },
      returnUrl: "r",
      notifyUrl: "w",
      description: "T",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await sandbox.fetchOrder(order.gatewayOrderId)).status).toBe("EXPIRED");
  });
});

/* ----------------------------------------------------- flag / checkout */

describe("checkout with Pay online", () => {
  it("TC-B26-A-022 flag off (default): ONLINE is refused and wallet checkout is unchanged", async () => {
    const s = await setup({ balancePaise: 100_000 });
    signInAs(s.customer);
    await addToCart(s.customer.id, s.listings[0].id, 1);
    const refused = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-flag-off-1", addressId: s.addressId, paymentMethod: "ONLINE" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Online payment is not available/);
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(paymentIntents)).toHaveLength(0);
    await expect(checkout({ userId: s.customer.id, addressId: s.addressId, requestId: "req-direct", paymentMethod: "ONLINE" })).rejects.toThrow(
      /Online payment is not available/,
    );

    const wallet = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-flag-off-2", addressId: s.addressId },
    });
    expect(wallet.status).toBe(201);
    expect(wallet.body.orders[0]).toMatchObject({ status: "CONFIRMED", paymentMethod: "WALLET" });
    expect(wallet.body.payment).toBeUndefined();
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, s.customer.id));
    expect(w.balancePaise).toBe(100_000 - wallet.body.orders[0].totalPaise);
  });

  it("TC-B26-A-023 flag on: order PENDING, stock held, cart cleared, one intent with a payment page", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    signInAs(s.customer);
    await addToCart(s.customer.id, s.listings[0].id, 2);
    const res = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-online-route", addressId: s.addressId, paymentMethod: "ONLINE" },
    });
    expect(res.status).toBe(201);
    expect(res.body.orders[0]).toMatchObject({ status: "PENDING", paymentMethod: "ONLINE" });
    expect(res.body.payment).toMatchObject({ status: "PENDING", alreadyPaid: false });
    expect(res.body.payment.redirectUrl).toMatch(/^\/orders\/pay\/sandbox\/gk_/);
    expect(await stockOf(s.listings[0].id)).toBe(8);
    const order = await orderOf(res.body.orders[0].id);
    expect(order.paidAt).toBeNull();
    const intent = await intentRow(res.body.payment.intentId);
    expect(intent).toMatchObject({ purpose: "ORDER", referenceId: order.id, amountPaise: order.totalPaise, gateway: "SANDBOX", status: "PENDING" });
    expect(intent.idempotencyKey).toBe(`pay:${order.checkoutKey}:1`);
    // The wallet was not touched.
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, s.customer.id));
    expect(w.balancePaise).toBe(0);
  });

  it("TC-B26-A-024 a double checkout with the same request id returns the same order and the same intent", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const first = await placeOnline(s, "req-double");
    const second = await startOnlineCheckout({ userId: s.customer.id, addressId: s.addressId, requestId: "req-double" });
    expect(second.deduplicated).toBe(true);
    expect(second.orders.map((o) => o.id)).toEqual(first.orders.map((o) => o.id));
    expect(second.payment!.intentId).toBe(first.payment!.intentId);
    expect(await db.select().from(paymentIntents)).toHaveLength(1);
    expect(await stockOf(s.listings[0].id)).toBe(8);
  });

  it("TC-B26-A-025 the same idempotency key never creates a second intent, even for concurrent calls", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const input = {
      purpose: "SHOP_REGISTRATION_FEE" as const,
      referenceId: s.shops[0].id,
      userId: s.owner.id,
      amountPaise: 50_000,
      customer: { id: s.owner.id },
      description: "Registration fee",
      idempotencyKey: "reg-fee-key-1",
      mode: "CHECKOUT" as const,
    };
    const results = await Promise.allSettled([createPaymentIntent(input), createPaymentIntent(input), createPaymentIntent(input)]);
    const ids = new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ intent: { id: string } }>).value.intent.id));
    expect(ids.size).toBe(1);
    expect(await db.select().from(paymentIntents)).toHaveLength(1);
    expect(await db.select().from(paymentSandboxOrders)).toHaveLength(1);
    await expect(createPaymentIntent({ ...input, amountPaise: 1 })).rejects.toThrow(/different payment/);
  });
});

/* ------------------------------------------------------------ webhook */

describe("payment webhook", () => {
  it("TC-B26-A-026 a webhook with a bad signature is rejected with 401 and recorded", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    const good = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS");
    const forged = new Headers(good.headers);
    forged.set("x-sandbox-signature", "0".repeat(64));
    const res = await postWebhook("sandbox", good.rawBody, forged);
    expect(res.status).toBe(401);
    const rows = await db.select().from(paymentWebhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signatureOk: false, outcome: "BAD_SIGNATURE" });
    expect((await intentRow(intent.id)).status).toBe("PENDING");
    expect((await orderOf(placed.orders[0].id)).status).toBe("PENDING");

    // A stale timestamp is refused too (replay protection).
    const stale = signSandboxWebhook(good.rawBody, String(Date.now() - 10 * 60_000));
    expect((await postWebhook("sandbox", stale.rawBody, stale.headers)).status).toBe(401);
    expect((await postWebhook("nosuchgateway", good.rawBody, good.headers)).status).toBe(404);
  });

  it("TC-B26-A-027 capture → order CONFIRMED with paidAt, order.placed event and customer + shop notified", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const res = await payAtSandbox(placed.payment!.intentId, "SUCCESS");
    expect(res).toMatchObject({ status: 200, body: { received: true, outcome: "MOVED" } });

    const order = await orderOf(placed.orders[0].id);
    expect(order.status).toBe("CONFIRMED");
    expect(order.paidAt).not.toBeNull();
    const intent = await intentRow(placed.payment!.intentId);
    expect(intent).toMatchObject({ status: "CAPTURED", method: "UPI" });
    expect(intent.gatewayPaymentId).toMatch(/^sbxpay_/);
    expect(await findCapturedIntent("ORDER", order.id)).toMatchObject({ id: intent.id });

    const events = await db.select().from(domainEvents).where(inArray(domainEvents.type, ["order.placed", "payment.captured"]));
    expect(events.map((e) => e.type).sort()).toEqual(["order.placed", "payment.captured"]);
    const customerNotes = await db.select().from(notifications).where(eq(notifications.userId, s.customer.id));
    expect(customerNotes.map((n) => n.type)).toEqual(expect.arrayContaining(["order.payment_captured", "order.confirmed"]));
    const shopNotes = await db.select().from(notifications).where(eq(notifications.userId, s.owner.id));
    expect(shopNotes.map((n) => n.type)).toContain("shop.new_order");
    const history = await db.select().from(paymentIntentEvents).where(eq(paymentIntentEvents.intentId, intent.id));
    expect(history.map((h) => h.toStatus)).toEqual(expect.arrayContaining(["CREATED", "PENDING", "CAPTURED"]));
  });

  it("TC-B26-A-028 a repeated event id is acknowledged and ignored", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    const webhook = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS");
    expect((await postWebhook("sandbox", webhook.rawBody, webhook.headers)).body.outcome).toBe("MOVED");
    const again = await postWebhook("sandbox", webhook.rawBody, signSandboxWebhook(webhook.rawBody).headers);
    expect(again).toMatchObject({ status: 200, body: { received: true, duplicate: true } });
    expect(await db.select().from(paymentWebhookEvents)).toHaveLength(1);
    const captures = await db.select().from(domainEvents).where(eq(domainEvents.type, "payment.captured"));
    expect(captures).toHaveLength(1);
  });

  it("TC-B26-A-029 the state comes from the gateway's fetchOrder, not from what the webhook says", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    // A correctly signed "captured" webhook while the gateway itself still says pending.
    const claim = sandbox.webhookFor({
      type: "PAYMENT_CAPTURED",
      merchantOrderId: intent.merchantOrderId,
      gatewayOrderId: intent.gatewayOrderId,
      paymentId: "fake",
      amountPaise: intent.amountPaise,
    });
    const res = await postWebhook("sandbox", claim.rawBody, claim.headers);
    expect(res.body.outcome).toBe("NO_CHANGE");
    expect((await intentRow(intent.id)).status).toBe("PENDING");
    expect((await orderOf(placed.orders[0].id)).status).toBe("PENDING");
  });

  it("TC-B26-A-030 an amount mismatch is not captured and support is alerted", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    const lying: GatewayOrderState = { gatewayOrderId: intent.gatewayOrderId!, status: "CAPTURED", amountPaise: 1, gatewayPaymentId: "p", method: "UPI" };
    expect((await applyGatewayState(intent.id, lying, { source: "WEBHOOK" })).outcome).toBe("AMOUNT_MISMATCH");
    expect((await intentRow(intent.id)).status).toBe("PENDING");
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "payment.attention"))).toHaveLength(1);
  });

  it("TC-B26-A-031 a webhook for a gateway without keys answers 503", async () => {
    const res = await handlePaymentWebhook("razorpay", "{}", new Headers());
    expect(res.status).toBe(503);
  });
});

/* ------------------------------------------------------ state machine */

describe("payment intent state machine", () => {
  it("TC-B26-A-032 an illegal transition is rejected (a captured payment cannot fail)", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    await payAtSandbox(placed.payment!.intentId, "SUCCESS");
    const intent = await intentRow(placed.payment!.intentId);
    const fail: GatewayOrderState = { gatewayOrderId: intent.gatewayOrderId!, status: "FAILED", amountPaise: intent.amountPaise, gatewayPaymentId: null, method: null };
    expect((await applyGatewayState(intent.id, fail, { source: "WEBHOOK" })).outcome).toBe("NO_CHANGE");
    expect((await intentRow(intent.id)).status).toBe("CAPTURED");
    const { transitionIntent } = await import("@/server/payments/intent-store");
    await expect(
      db.transaction(async (tx) => transitionIntent(tx, await intentRow(intent.id), "FAILED", { source: "SYSTEM" })),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

/* ---------------------------------------------- failure / expiry / retry */

describe("failed and expired payments", () => {
  it("TC-B26-A-033 failure → order PAYMENT_FAILED, stock released, customer told; retry reuses the order", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    expect(await stockOf(s.listings[0].id)).toBe(8);
    await payAtSandbox(placed.payment!.intentId, "FAILURE");
    const order = await orderOf(placed.orders[0].id);
    expect(order.status).toBe("PAYMENT_FAILED");
    expect(order.paidAt).toBeNull();
    expect(await stockOf(s.listings[0].id)).toBe(10);
    expect((await intentRow(placed.payment!.intentId)).status).toBe("FAILED");
    const notes = await db.select().from(notifications).where(eq(notifications.userId, s.customer.id));
    expect(notes.map((n) => n.type)).toContain("order.payment_failed");

    // Retry: same order, stock taken again, a new attempt (double click → same attempt).
    const retry = await retryOrderPayment(s.customer.id, order.id);
    const retryAgain = await retryOrderPayment(s.customer.id, order.id);
    expect(retryAgain.intentId).toBe(retry.intentId);
    expect(retry.intentId).not.toBe(placed.payment!.intentId);
    expect(await stockOf(s.listings[0].id)).toBe(8);
    expect((await intentRow(retry.intentId)).idempotencyKey).toBe(`pay:${order.checkoutKey}:2`);
    await payAtSandbox(retry.intentId, "SUCCESS");
    const paid = await orderOf(order.id);
    expect(paid.status).toBe("CONFIRMED");
    expect(paid.paidAt).not.toBeNull();
    // Nothing left to pay: a further retry is told so and opens nothing.
    const after = await retryOrderPayment(s.customer.id, order.id);
    expect(after.alreadyPaid).toBe(true);
    expect(await db.select().from(paymentIntents)).toHaveLength(2);
  });

  it("TC-B26-A-034 expiry → order PAYMENT_FAILED with stock released", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    await payAtSandbox(placed.payment!.intentId, "EXPIRE");
    expect((await intentRow(placed.payment!.intentId)).status).toBe("EXPIRED");
    expect((await orderOf(placed.orders[0].id)).status).toBe("PAYMENT_FAILED");
    expect(await stockOf(s.listings[0].id)).toBe(10);
    expect((await db.select().from(notifications).where(eq(notifications.userId, s.customer.id))).map((n) => n.type)).toContain(
      "order.payment_expired",
    );
  });

  it("TC-B26-A-035 a payment in progress blocks cancelling; a failed one cancels without restocking twice", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const orderId = placed.orders[0].id;
    await expect(cancelOrder(orderId, { id: s.customer.id, role: "CUSTOMER" }, "changed my mind", { selfService: true })).rejects.toThrow(
      /payment for this order is in progress/,
    );
    await payAtSandbox(placed.payment!.intentId, "FAILURE");
    expect(await stockOf(s.listings[0].id)).toBe(10);
    const cancelled = await cancelOrder(orderId, { id: s.customer.id, role: "CUSTOMER" }, "changed my mind", { selfService: true });
    expect(cancelled.status).toBe("CANCELLED");
    expect(await stockOf(s.listings[0].id)).toBe(10);
  });

  it("TC-B26-A-036 the sandbox page path (simulateSandboxCheckout) pays and returns to the return page; other users cannot use it", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    const stranger = await createUser();
    await expect(simulateSandboxCheckout({ ref: intent.merchantOrderId, viewerId: stranger.id, outcome: "SUCCESS" })).rejects.toThrow();
    const done = await simulateSandboxCheckout({ ref: intent.merchantOrderId, viewerId: s.customer.id, outcome: "SUCCESS", method: "NETBANKING" });
    expect(done.returnPath).toBe(`/orders/payment-return?intent=${intent.id}`);
    expect(done.webhookStatus).toBe(200);
    expect((await intentRow(intent.id)).method).toBe("NETBANKING");
    expect((await orderOf(placed.orders[0].id)).status).toBe("CONFIRMED");
  });
});

/* ----------------------------------------------------- reconciliation */

describe("reconciliation job", () => {
  it("TC-B26-A-037 a stuck PENDING intent is settled from the gateway (captured while the webhook never arrived)", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS"); // the webhook is "lost"
    await db.update(paymentIntents).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(paymentIntents.id, intent.id));
    const res = await call(reconcileRoute, "/api/cron/payments-reconcile", { method: "POST" });
    expect(res.status).toBe(403);
    const result = await runPaymentReconciliation();
    expect(result).toMatchObject({ checked: 1, moved: 1, errors: [] });
    expect((await intentRow(intent.id)).status).toBe("CAPTURED");
    expect((await orderOf(placed.orders[0].id)).status).toBe("CONFIRMED");
    // A second run finds nothing to do.
    expect((await runPaymentReconciliation()).checked).toBe(0);
  });

  it("TC-B26-A-038 a stuck intent past its expiry becomes EXPIRED and the order releases its stock", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intent = await intentRow(placed.payment!.intentId);
    const past = new Date(Date.now() - 60_000);
    await db.update(paymentIntents).set({ expiresAt: past }).where(eq(paymentIntents.id, intent.id));
    await db.update(paymentSandboxOrders).set({ expiresAt: past }).where(eq(paymentSandboxOrders.gatewayOrderId, intent.gatewayOrderId!));
    const result = await runPaymentReconciliation();
    expect(result.moved).toBe(1);
    expect((await intentRow(intent.id)).status).toBe("EXPIRED");
    expect((await orderOf(placed.orders[0].id)).status).toBe("PAYMENT_FAILED");
    expect(await stockOf(s.listings[0].id)).toBe(10);
  });

  it("TC-B26-A-039 polls a PENDING refund and settles it when the gateway confirms", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    await payAtSandbox(placed.payment!.intentId, "SUCCESS");
    sandboxSettings.refundMode = "PENDING";
    const refund = await refundPaymentIntent({ intentId: placed.payment!.intentId, amountPaise: 1000, reason: "goodwill", idempotencyKey: "rf-poll-1" });
    expect(refund.status).toBe("PENDING");
    expect((await runPaymentReconciliation()).refundsSettled).toBe(0);
    const [row] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, refund.id));
    expect(row.pollAttempts).toBe(1);
    const intent = await intentRow(placed.payment!.intentId);
    await sandbox.settleRefund(intent.gatewayOrderId!, row.merchantRefundId, "SUCCESS");
    expect((await runPaymentReconciliation()).refundsSettled).toBe(1);
    expect(await intentRow(intent.id)).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedPaise: 1000 });
  });
});

/* ------------------------------------------------------------- refunds */

describe("refunds to the original method", () => {
  it("TC-B26-A-040 a partial then a full refund: PARTIALLY_REFUNDED → REFUNDED, idempotent, never above the captured amount", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const intentId = placed.payment!.intentId;
    await expect(refundPaymentIntent({ intentId, amountPaise: 100, reason: "x", idempotencyKey: "too-early" })).rejects.toThrow(
      /Only a received payment/,
    );
    await payAtSandbox(intentId, "SUCCESS");
    const total = (await intentRow(intentId)).amountPaise;

    const partial = await refundPaymentIntent({ intentId, amountPaise: 2000, reason: "one item missing", idempotencyKey: "rf-1" });
    expect(partial.status).toBe("SUCCESS");
    expect(await getPaymentIntent(intentId)).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedPaise: 2000 });
    const replay = await refundPaymentIntent({ intentId, amountPaise: 2000, reason: "one item missing", idempotencyKey: "rf-1" });
    expect(replay.id).toBe(partial.id);
    await expect(refundPaymentIntent({ intentId, amountPaise: total, reason: "too much", idempotencyKey: "rf-2" })).rejects.toThrow(/can still be refunded/);

    const rest = await refundPaymentIntent({ intentId, amountPaise: total - 2000, reason: "order cancelled", idempotencyKey: "rf-3" });
    expect(rest.status).toBe("SUCCESS");
    expect(await getPaymentIntent(intentId)).toMatchObject({ status: "REFUNDED", refundedPaise: total });
    expect(await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId))).toHaveLength(2);
    const refundedEvents = await db.select().from(domainEvents).where(eq(domainEvents.type, "payment.refunded"));
    expect(refundedEvents.map((e) => e.toStatus)).toEqual(["PARTIALLY_REFUNDED", "REFUNDED"]);
    expect((await db.select().from(notifications).where(eq(notifications.userId, s.customer.id))).filter((n) => n.type === "order.payment_refunded")).toHaveLength(2);
  });

  it("TC-B26-A-041 cancelling a paid online order queues a refund to the original method; the job sends it and the order ends REFUNDED", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    await payAtSandbox(placed.payment!.intentId, "SUCCESS");
    const orderId = placed.orders[0].id;
    const cancelled = await cancelOrder(orderId, { id: s.owner.id, role: "SHOP_OWNER" }, "out of stock");
    expect(cancelled.status).toBe("REFUND_PENDING");
    const [queued] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.orderId, orderId));
    expect(queued).toMatchObject({ status: "PENDING", submittedAt: null });
    // The wallet is not credited for an online payment.
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, s.customer.id));
    expect(w.balancePaise).toBe(0);
    const run = await runPaymentReconciliation();
    expect(run).toMatchObject({ refundsSubmitted: 1, refundsSettled: 1 });
    expect((await orderOf(orderId)).status).toBe("REFUNDED");
    expect((await intentRow(placed.payment!.intentId)).status).toBe("REFUNDED");
    expect(await stockOf(s.listings[0].id)).toBe(10);
  });
});

/* ---------------------------------------------------- multi-shop + view */

describe("multi-shop and the return page", () => {
  it("TC-B26-A-042 a two-shop cart is one ORDER_GROUP payment; capture confirms both orders", async () => {
    const s = await setup({ shops: 2 });
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    expect(placed.orders).toHaveLength(2);
    const intent = await intentRow(placed.payment!.intentId);
    expect(intent.purpose).toBe("ORDER_GROUP");
    expect(intent.referenceId).toBe(placed.orders[0].orderGroupId);
    expect(intent.amountPaise).toBe(placed.orders.reduce((n, o) => n + o.totalPaise, 0));
    await payAtSandbox(intent.id, "SUCCESS");
    for (const o of placed.orders) expect((await orderOf(o.id)).status).toBe("CONFIRMED");
  });

  it("TC-B26-A-043 the status endpoint and retry are the payer's only", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const placed = await placeOnline(s);
    const stranger = await createUser();
    signInAs(stranger);
    const hidden = await call(intentRoute, `/api/payments/intents/${placed.payment!.intentId}`, { params: { id: placed.payment!.intentId } });
    expect(hidden.status).toBe(404);
    const retry = await call(payRoute, `/api/orders/${placed.orders[0].id}/pay`, { method: "POST", params: { id: placed.orders[0].id } });
    expect(retry.status).toBe(403);
    signInAs(s.customer);
    const mine = await call(intentRoute, `/api/payments/intents/${placed.payment!.intentId}`, { params: { id: placed.payment!.intentId } });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ status: "PENDING", canRetry: false, orders: [{ id: placed.orders[0].id, status: "PENDING" }] });
    await payAtSandbox(placed.payment!.intentId, "FAILURE");
    const failed = await call(intentRoute, `/api/payments/intents/${placed.payment!.intentId}`, { params: { id: placed.payment!.intentId } });
    expect(failed.body).toMatchObject({ status: "FAILED", canRetry: true });
    const retried = await call(payRoute, `/api/orders/${placed.orders[0].id}/pay`, { method: "POST", params: { id: placed.orders[0].id } });
    expect(retried.status).toBe(200);
    expect(retried.body.redirectUrl).toMatch(/^\/orders\/pay\/sandbox\//);
  });

  it("TC-B26-A-044 a gateway that cannot be reached leaves no half-paid order: checkout is refused before any order is made", async () => {
    const s = await setup();
    await onlinePaymentsOn(s.admin);
    const broken: PaymentGateway = Object.assign(Object.create(SandboxGateway.prototype), {
      name: "SANDBOX",
      isConfigured: () => false,
    });
    setGatewayOverrideForTests("SANDBOX", broken);
    await addToCart(s.customer.id, s.listings[0].id, 1);
    await expect(startOnlineCheckout({ userId: s.customer.id, addressId: s.addressId, requestId: "req-broken" })).rejects.toThrow(
      /Online payment is not available/,
    );
    expect(await db.select().from(orders).where(and(eq(orders.userId, s.customer.id)))).toHaveLength(0);
  });
});
