/**
 * batch-2026-10 WS-C — F6.2.3 (GS-073): refunds with an itemised breakdown
 * and the customer's choice (wallet, instant; or the original payment method
 * through the gateway). The payment-intent service belongs to workstream A,
 * so it is mocked here: a "captured intent" marks an order as paid online.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const intents = vi.hoisted(() => ({
  captured: new Map<string, { id: string; amountPaise: number }>(),
  refundResult: "PENDING" as "PENDING" | "SUCCESS" | "FAILED" | "THROW",
  intentStatus: "CAPTURED" as string,
  refundCalls: [] as { intentId: string; amountPaise: number; idempotencyKey: string }[],
}));

vi.mock("@/server/payments/intents", () => {
  const ref = (orderId: string) => {
    const hit = intents.captured.get(orderId);
    return hit
      ? {
          id: hit.id,
          purpose: "ORDER",
          referenceId: orderId,
          userId: null,
          amountPaise: hit.amountPaise,
          refundedPaise: intents.intentStatus === "CAPTURED" ? 0 : hit.amountPaise,
          status: intents.intentStatus,
          gateway: "SANDBOX",
          gatewayOrderId: `gw-${orderId}`,
          gatewayPaymentId: `pay-${orderId}`,
        }
      : null;
  };
  return {
    PAYMENT_INTENT_STATUSES: [],
    createPaymentIntent: vi.fn(),
    findCapturedIntent: vi.fn(async (_purpose: string, referenceId: string) => ref(referenceId)),
    getPaymentIntent: vi.fn(async (id: string) => {
      for (const [orderId, hit] of intents.captured) if (hit.id === id) return ref(orderId);
      return null;
    }),
    refundPaymentIntent: vi.fn(async (input: { intentId: string; amountPaise: number; idempotencyKey: string }) => {
      intents.refundCalls.push(input);
      if (intents.refundResult === "THROW") throw new Error("gateway timeout");
      return { id: `rf-${input.idempotencyKey}`, intentId: input.intentId, amountPaise: input.amountPaise, status: intents.refundResult };
    }),
  };
});

import { db } from "@/server/db";
import { notificationDeliveries, orderRefundEvents, orderRefunds, orders, wallets } from "@/server/db/schema";
import { cancelOrderWithChoice, quoteCancellation } from "@/server/aftercare/cancellation";
import { computeRefundBreakdown, listRefundsForOrder, recordGatewayRefundResult, runRefundSweep } from "@/server/aftercare/refunds";
import { cancelOrder } from "@/server/services/orders";
import { createOrder, createShop, createUser, createUserWithWallet, resetDatabase } from "../helpers/fixtures";
import { DELIVERY_FEE, GOODS, START, balanceOf, clearBatchCRules, paidOrderAt, setRuleRaw } from "../helpers/batch-c";

const PAID = GOODS + DELIVERY_FEE;

beforeEach(async () => {
  intents.captured.clear();
  intents.refundCalls.length = 0;
  intents.refundResult = "PENDING";
  intents.intentStatus = "CAPTURED";
  await resetDatabase();
  await clearBatchCRules();
});
afterEach(clearBatchCRules);

/** An order paid online (no wallet debit; a captured gateway payment). The customer has no wallet unless asked. */
async function onlineOrder(options: { withWallet?: boolean; status?: "CONFIRMED" | "READY" } = {}) {
  const customer = options.withWallet ? (await createUserWithWallet({ balancePaise: 0 })).user : await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id);
  const order = await createOrder(customer.id, shop.id, {
    status: options.status ?? "CONFIRMED",
    subtotalPaise: GOODS,
    deliveryFeePaise: DELIVERY_FEE,
    paidAt: new Date(),
  });
  intents.captured.set(order.id, { id: `intent-${order.id}`, amountPaise: PAID });
  return { customer: { id: customer.id, role: "CUSTOMER" as const }, owner: { id: owner.id, role: "SHOP_OWNER" as const }, order };
}

const refundOf = async (orderId: string) => (await db.select().from(orderRefunds).where(eq(orderRefunds.orderId, orderId)))[0];
const orderStatus = async (orderId: string) => (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!.status;

describe("F6.2.3 breakdown", () => {
  it("TC-B26-C-016 the breakdown itemises what was paid, the deductions and the refund (paid = items + delivery fee)", async () => {
    await setRuleRaw("afterPackingCancellation", { enabled: true, defaultFeePaise: 2_500 });
    const s = await paidOrderAt("READY");
    const b = await computeRefundBreakdown(s.order.id, { selfService: true });
    expect(b.paymentChannel).toBe("WALLET");
    expect(b.paidLines).toEqual([
      expect.objectContaining({ code: "ITEMS", amountPaise: GOODS }),
      expect.objectContaining({ code: "DELIVERY_FEE", amountPaise: DELIVERY_FEE }),
    ]);
    expect(b.paidPaise).toBe(PAID);
    expect(b.deductionsPaise).toBe(2_500);
    expect(b.refundPaise).toBe(PAID - 2_500);
    // The shop's / support's view: no deduction.
    expect((await computeRefundBreakdown(s.order.id, { selfService: false })).refundPaise).toBe(PAID);
  });

  it("TC-B26-C-017 an unpaid cash order has nothing to refund and no fee is charged", async () => {
    await setRuleRaw("afterPackingCancellation", { enabled: true });
    const customer = await createUser();
    const shop = await createShop((await createUser({ role: "SHOP_OWNER" })).id);
    const order = await createOrder(customer.id, shop.id, { status: "READY", paidAt: null });
    await db.update(orders).set({ paymentMethod: "COD" }).where(eq(orders.id, order.id));
    const b = await computeRefundBreakdown(order.id, { selfService: true });
    expect(b.paymentChannel).toBe("COD");
    expect(b.paid).toBe(false);
    expect(b.refundPaise).toBe(0);
    expect(b.deductionsPaise).toBe(0);
  });
});

describe("F6.2.3 refund to the wallet", () => {
  it("TC-B26-C-018 wallet-paid and cash orders are always refunded to the wallet (no original-method choice)", async () => {
    await setRuleRaw("refundChoice", { originalMethodEnabled: true });
    const s = await paidOrderAt("CONFIRMED");
    const quote = await quoteCancellation(s.order.id, s.customer);
    expect(quote.refundMethods.map((m) => m.method)).toEqual(["WALLET"]);
    await expect(cancelOrderWithChoice(s.order.id, s.customer, { refundMethod: "ORIGINAL" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balanceOf(s.customer.id)).toBe(START - PAID);
    const cod = await createOrder(s.customer.id, s.shop.id, { status: "DELIVERED", paidAt: new Date() });
    await db.update(orders).set({ paymentMethod: "COD" }).where(eq(orders.id, cod.id));
    expect((await computeRefundBreakdown(cod.id, { selfService: false })).paymentChannel).toBe("COD");
  });

  it("TC-B26-C-019 a wallet refund is instant: SUCCESS at once, order REFUNDED, timeline REQUESTED → SUCCESS", async () => {
    const s = await paidOrderAt("CONFIRMED");
    const result = await cancelOrderWithChoice(s.order.id, s.customer, { refundMethod: "WALLET", expectedRefundPaise: PAID });
    expect(result.order.status).toBe("REFUNDED");
    expect(result.refund).toMatchObject({ method: "WALLET", status: "SUCCESS", amountPaise: PAID });
    expect(await balanceOf(s.customer.id)).toBe(START);
    const events = await db.select().from(orderRefundEvents).where(eq(orderRefundEvents.orderId, s.order.id));
    expect(events.map((e) => e.status)).toEqual(["REQUESTED", "SUCCESS"]);
    const views = await listRefundsForOrder(s.order.id);
    expect(views).toHaveLength(1);
    expect(views[0].timeline.map((t) => t.status)).toEqual(["REQUESTED", "SUCCESS"]);
  });

  it("TC-B26-C-020 an online-paid order refunded to the wallet creates the customer's wallet if they had none", async () => {
    const o = await onlineOrder({ withWallet: false });
    expect(await db.query.wallets.findFirst({ where: eq(wallets.userId, o.customer.id) })).toBeUndefined();
    const result = await cancelOrderWithChoice(o.order.id, o.customer, { refundMethod: "WALLET" });
    expect(result.refund).toMatchObject({ method: "WALLET", status: "SUCCESS", amountPaise: PAID });
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, o.customer.id) });
    expect(wallet).toMatchObject({ balancePaise: PAID, promotionalBalancePaise: 0 });
    expect(intents.refundCalls).toHaveLength(0);
  });

  it("TC-B26-C-021 every refund status is queued to the customer by email AND push", async () => {
    const s = await paidOrderAt("CONFIRMED");
    await cancelOrderWithChoice(s.order.id, s.customer, { refundMethod: "WALLET" });
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, s.customer.id), eq(notificationDeliveries.type, "order.refund_updated")));
    expect(deliveries.map((d) => d.channel).sort()).toEqual(["EMAIL", "PUSH"]);
  });

  it("TC-B26-C-022 refunds made by the original path (shop cancel) still show on the timeline, from the wallet ledger", async () => {
    const s = await paidOrderAt("CONFIRMED");
    await cancelOrder(s.order.id, s.owner, "Out of stock");
    const views = await listRefundsForOrder(s.order.id);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: null, method: "WALLET", status: "SUCCESS", amountPaise: PAID });
  });
});

describe("F6.2.3 refund to the original payment method", () => {
  it("TC-B26-C-023 rule off (production default): an online order is offered the wallet only", async () => {
    const o = await onlineOrder();
    const quote = await quoteCancellation(o.order.id, o.customer);
    expect(quote.breakdown.paymentChannel).toBe("ONLINE");
    expect(quote.refundMethods.map((m) => m.method)).toEqual(["WALLET"]);
  });

  it("TC-B26-C-024 rule on: ORIGINAL calls refundPaymentIntent with the refund amount and records PROCESSING, then SUCCESS from the sweep", async () => {
    await setRuleRaw("refundChoice", { originalMethodEnabled: true });
    const o = await onlineOrder();
    const quote = await quoteCancellation(o.order.id, o.customer);
    expect(quote.refundMethods.map((m) => m.method)).toEqual(["ORIGINAL", "WALLET"]);
    const result = await cancelOrderWithChoice(o.order.id, o.customer, { refundMethod: "ORIGINAL", expectedRefundPaise: PAID });
    expect(intents.refundCalls).toEqual([expect.objectContaining({ intentId: `intent-${o.order.id}`, amountPaise: PAID })]);
    expect(result.refund).toMatchObject({ method: "ORIGINAL", status: "PROCESSING" });
    expect(await orderStatus(o.order.id)).toBe("REFUND_PENDING");
    const refund = await refundOf(o.order.id);
    expect(refund.gatewayRefundRef).toBe(`rf-order-refund:${refund.id}`);

    intents.intentStatus = "REFUNDED";
    expect(await runRefundSweep()).toMatchObject({ completed: 1 });
    expect((await refundOf(o.order.id)).status).toBe("SUCCESS");
    expect(await orderStatus(o.order.id)).toBe("REFUNDED");
    const events = await db.select().from(orderRefundEvents).where(eq(orderRefundEvents.orderId, o.order.id));
    expect(events.map((e) => e.status)).toEqual(["REQUESTED", "PROCESSING", "SUCCESS"]);
    // No money went to a wallet.
    expect(await db.query.wallets.findFirst({ where: eq(wallets.userId, o.customer.id) })).toBeUndefined();
  });

  it("TC-B26-C-025 the gateway's webhook result completes a refund once (idempotent)", async () => {
    await setRuleRaw("refundChoice", { originalMethodEnabled: true });
    const o = await onlineOrder();
    await cancelOrderWithChoice(o.order.id, o.customer, { refundMethod: "ORIGINAL" });
    const refund = await refundOf(o.order.id);
    await recordGatewayRefundResult(`order-refund:${refund.id}`, "SUCCESS", "gw-ref-1");
    await recordGatewayRefundResult(`order-refund:${refund.id}`, "SUCCESS", "gw-ref-1");
    expect(await refundOf(o.order.id)).toMatchObject({ status: "SUCCESS", gatewayRefundRef: "gw-ref-1" });
    const successEvents = (await db.select().from(orderRefundEvents).where(eq(orderRefundEvents.refundId, refund.id))).filter((e) => e.status === "SUCCESS");
    expect(successEvents).toHaveLength(1);
  });

  it("TC-B26-C-026 a gateway failure is recorded FAILED, then (rule) the amount goes to the wallet instead", async () => {
    await setRuleRaw("refundChoice", { originalMethodEnabled: true });
    intents.refundResult = "FAILED";
    const o = await onlineOrder();
    await cancelOrderWithChoice(o.order.id, o.customer, { refundMethod: "ORIGINAL" });
    const refund = await refundOf(o.order.id);
    expect(refund).toMatchObject({ method: "WALLET", status: "SUCCESS", fellBackToWallet: true });
    expect(await balanceOf(o.customer.id)).toBe(PAID);
    expect(await orderStatus(o.order.id)).toBe("REFUNDED");
    const events = await db.select().from(orderRefundEvents).where(eq(orderRefundEvents.refundId, refund.id));
    expect(events.map((e) => e.status)).toEqual(["REQUESTED", "FAILED", "SUCCESS"]);
  });

  it("TC-B26-C-027 a gateway call that throws is retried by the sweep, and after the last attempt falls back to the wallet", async () => {
    await setRuleRaw("refundChoice", { originalMethodEnabled: true, maxGatewayAttempts: 2 });
    intents.refundResult = "THROW";
    const o = await onlineOrder();
    await cancelOrderWithChoice(o.order.id, o.customer, { refundMethod: "ORIGINAL" });
    expect(await refundOf(o.order.id)).toMatchObject({ status: "REQUESTED", attempts: 1 });
    await runRefundSweep();
    expect(intents.refundCalls).toHaveLength(2);
    expect(await refundOf(o.order.id)).toMatchObject({ status: "SUCCESS", method: "WALLET", fellBackToWallet: true, attempts: 2 });
    expect(await balanceOf(o.customer.id)).toBe(PAID);
  });

  it("TC-B26-C-028 a shop cancelling an online-paid order refunds through the aftercare path (not the wallet-debit reversal that would fail)", async () => {
    const o = await onlineOrder({ withWallet: true });
    const result = await cancelOrder(o.order.id, o.owner, "Out of stock");
    expect(result.status).toBe("REFUNDED");
    expect(await balanceOf(o.customer.id)).toBe(PAID);
    expect((await refundOf(o.order.id)).method).toBe("WALLET");
  });
});
