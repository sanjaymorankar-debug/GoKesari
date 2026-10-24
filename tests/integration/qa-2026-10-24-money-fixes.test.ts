/**
 * Money, order and subscription fixes from the QA run of 24 Oct 2026
 * (tests/qa money-*, finance-*, access-*). Each block names the TC ID whose
 * run found the defect:
 *
 * TC-PAY-032 / TC-COD-011  reconciliation reported every paid order "actual 0"
 * TC-PAY-029               a removed line of an online-paid order answered 404
 * TC-PAY-026               the money trace showed no payment for an online order
 * TC-SUB-013               subscription orders carried no delivery address
 * TC-SUB-008               a cancelled subscription could still be PATCHed
 * TC-FLD-107/108/109       subscription quantities and dates (500s, off-step, past)
 * TC-COD-010               a negative rider payout was an ordinary PENDING payout
 * TC-NTF-012               marking someone else's notification read answered 200
 * TC-PAY-004               verify of an unpaid top-up answered 500 (called Cashfree in MOCK mode)
 * TC-FLD-032               a ₹10 crore low-balance threshold was accepted
 * TC-FLD-114               vouchers with budget 0, an end date passed, budget < one bonus
 * N1                       reconciliation: settlement, payout and gateway checks read 0 too
 * N2                       a refund after delivery (return, admin) of an online-paid order answered 404
 * N6 / TC-SPI-010          an approved substitution kept the original product out of stock
 * TC-FLD-112/113/116/117   registration fee, shop payment, adjustment and COD deposit bounds
 * TC-FLD-118               a settlement for this week's (unfinished) or a future week
 * TC-SPI-004 (online)      the order-confirmed e-mail of an online-paid order lists lines, fee, total
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as codDepositPost } from "@/app/api/admin/cod/route";
import { POST as adjustmentsPost } from "@/app/api/finance/adjustments/route";
import { POST as financeRefundsPost } from "@/app/api/finance/refunds/route";
import { POST as settlementsPost } from "@/app/api/finance/settlements/route";
import { PATCH as notificationsPatch } from "@/app/api/notifications/route";
import { POST as registrationFeesPost } from "@/app/api/registration-fees/route";
import { POST as shopPaymentsPost } from "@/app/api/shop-payments/route";
import { PATCH as subscriptionPatch } from "@/app/api/subscriptions/[id]/route";
import { POST as overridePost } from "@/app/api/subscriptions/[id]/override/route";
import { POST as pausePost } from "@/app/api/subscriptions/[id]/pause/route";
import { POST as renewPost } from "@/app/api/subscriptions/[id]/renew/route";
import { POST as retryPost } from "@/app/api/subscriptions/[id]/retry/route";
import { POST as skipPost } from "@/app/api/subscriptions/[id]/skip/route";
import { POST as subscriptionsPost } from "@/app/api/subscriptions/route";
import { POST as vouchersPost } from "@/app/api/vouchers/route";
import { PATCH as walletSettingsPatch } from "@/app/api/wallet/settings/route";
import { POST as verifyRoute } from "@/app/api/wallet/verify/route";
import { POST as webhookRoute } from "@/app/api/webhooks/payments/[gateway]/route";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  deliveryPartnerEarnings,
  financialAdjustments,
  inventoryMovements,
  notificationDeliveries,
  notifications,
  orderFinancials,
  orderItems,
  orderRefunds,
  orders,
  paymentIntents,
  paymentRefunds,
  payments,
  platformSettings,
  riderPayouts,
  shopProducts,
  shopSettlements,
  shops,
  subscriptionDeliveries,
  vouchers,
  wallets,
} from "@/server/db/schema";
import { getGatewayByName } from "@/server/payments/gateway/registry";
import { sandboxSettings, type SandboxGateway } from "@/server/payments/gateway/sandbox";
import { startOnlineCheckout } from "@/server/payments/order-payments";
import { runPaymentReconciliation } from "@/server/payments/processing";
import { addToCart } from "@/server/services/cart";
import { recordCodCollection } from "@/server/services/cod";
import {
  decideRiderPayout,
  getOrderFinancialTrace,
  listFinancialExceptions,
  listReconciliationRecords,
  prepareRiderPayouts,
  prepareShopSettlements,
  previousWeekStart,
  recordOrderFinancials,
  refundDeliveredOrder,
  runReconciliation,
} from "@/server/services/finance";
import { acceptOrder, decideSubstitution, proposeSubstitution, removeItem, startPicking } from "@/server/services/fulfilment";
import { cancelOrder, checkout } from "@/server/services/orders";
import { createTopUpOrder, settleMockTopUp, signForMock } from "@/server/services/payments";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { cancelSubscription, createSubscription, generateDailyOrders } from "@/server/services/subscriptions";
import { updateVoucher } from "@/server/services/vouchers";
import { DELIVERY_FEE, paidOrderAt } from "../helpers/batch-c";
import { call } from "../helpers/http";
import {
  createCategory,
  createDeliveryPartner,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createStandardMilkSetup,
  createUser,
  createUserWithWallet,
  createVoucher as createVoucherRow,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
const TODAY = () => todayIn(getEnv().APP_TIMEZONE);
let seq = 0;

type Person = { id: string; email: string; name: string | null; role: UserRole };
function signIn(user: Person) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function cleanPaymentTables() {
  await db.execute(sql`TRUNCATE TABLE payment_webhook_events, payment_refunds, payment_intent_events, payment_intents, payment_sandbox_orders CASCADE`);
}

async function clearMyRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["onlinePayments", "refundChoice"]));
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
  sandboxSettings.refundMode = "SUCCESS";
  await clearMyRules();
});

/* ------------------------------------------------------------ helpers */

/** A customer's order for two lines (₹70 + ₹45) at one shop with a ₹15 delivery fee, paid online at the sandbox gateway. */
async function onlinePaidOrder() {
  const admin = await createUser({ role: "ADMIN" });
  const { user: customer } = await createUserWithWallet({ balancePaise: 0 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const curd = await createProduct(category.id, { name: "Curd", unit: "piece" });
  const shop = await createShop(owner.id, { name: "Online Dairy", deliveryFeePaise: DELIVERY_FEE });
  const milkListing = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 10 });
  const curdListing = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 4500, onlineStock: 10 });
  await setRule("onlinePayments", { enabled: true }, { id: admin.id, role: "ADMIN" });
  await addToCart(customer.id, milkListing.id, 1);
  await addToCart(customer.id, curdListing.id, 1);
  const placed = await startOnlineCheckout({
    userId: customer.id,
    addressId: await deliveryAddressId(customer.id),
    requestId: `req-online-${++seq}`,
  });
  const intentId = placed.payment!.intentId;
  const intent = await intentRow(intentId);
  const webhook = await sandbox.simulate(intent.gatewayOrderId!, "SUCCESS", "UPI");
  const res = await webhookRoute(
    new NextRequest("http://localhost/api/webhooks/payments/sandbox", { method: "POST", body: webhook.rawBody, headers: webhook.headers }),
    { params: Promise.resolve({ gateway: "sandbox" }) },
  );
  expect(res.status).toBe(200);
  const order = await orderRow(placed.orders[0].id);
  expect(order.status).toBe("CONFIRMED");
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return {
    admin: { id: admin.id, role: "ADMIN" as const },
    customer,
    owner: { id: owner.id, role: "SHOP_OWNER" as const },
    order,
    intentId,
    milkLine: items.find((i) => i.lineTotalPaise === 7000)!,
    curdLine: items.find((i) => i.lineTotalPaise === 4500)!,
  };
}

const intentRow = async (id: string) => (await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) }))!;
const orderRow = async (id: string) => (await db.query.orders.findFirst({ where: eq(orders.id, id) }))!;
const balanceOf = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))?.balancePaise ?? 0;

async function reconcileToday(admin: { id: string; role: UserRole }) {
  await runReconciliation(TODAY(), addDays(TODAY(), 1), admin);
  const records = await listReconciliationRecords({ limit: 1000 });
  return (entityId: string, checkType = "ORDER_PAYMENT") => records.find((r) => r.entityId === entityId && r.checkType === checkType);
}

/* ===================================================== reconciliation */

describe("TC-PAY-032 / TC-COD-011: reconciliation counts the money actually taken", () => {
  it("wallet-paid, cash-collected and online-captured orders match; an altered total shows both amounts", async () => {
    const wallet = await paidOrderAt("CONFIRMED");
    const altered = await paidOrderAt("CONFIRMED");
    await db.update(orders).set({ totalPaise: altered.order.totalPaise + 100 }).where(eq(orders.id, altered.order.id));

    // A delivered COD order of ₹1,950 whose cash was collected.
    const codCustomer = await createUser();
    const codOrder = await createOrder(codCustomer.id, wallet.shop.id, { status: "DELIVERED", subtotalPaise: 195_000 });
    await db.update(orders).set({ paymentMethod: "COD" }).where(eq(orders.id, codOrder.id));
    await recordCodCollection({ ...codOrder, paymentMethod: "COD" }, wallet.admin.id, db);

    const online = await onlinePaidOrder();
    const captured = await intentRow(online.intentId);

    // A wallet top-up paid at the (mock) gateway and credited once.
    const topUp = await createTopUpOrder(wallet.customer.id, 25_000);
    await settleMockTopUp({
      userId: wallet.customer.id,
      gatewayOrderId: topUp.gatewayOrderId,
      gatewayPaymentId: "mock_pay_recon",
      signature: signForMock(topUp.gatewayOrderId, "mock_pay_recon"),
    });

    const pick = await reconcileToday(wallet.admin);
    expect(pick(wallet.order.id)).toMatchObject({ status: "MATCHED", expectedPaise: wallet.order.totalPaise, actualPaise: wallet.order.totalPaise });
    expect(pick(codOrder.id)).toMatchObject({ status: "MATCHED", expectedPaise: 195_000, actualPaise: 195_000 });
    expect(pick(online.order.id)).toMatchObject({ status: "MATCHED", expectedPaise: captured.amountPaise, actualPaise: captured.amountPaise });
    expect(pick(altered.order.id)).toMatchObject({
      status: "PARTIAL",
      expectedPaise: altered.order.totalPaise + 100,
      actualPaise: altered.order.totalPaise,
    });
    expect(pick(topUp.payment.id, "GATEWAY_CREDIT")).toMatchObject({ status: "MATCHED", expectedPaise: 25_000, actualPaise: 25_000 });
  });
});

/* =============================================== line refunds by method */

describe("TC-PAY-029: a removed line is refunded the way the order was paid", () => {
  it("online-paid: the line's exact amount goes back to the payment (not the wallet); the order carries on and still reconciles", async () => {
    const s = await onlinePaidOrder();
    await acceptOrder(s.order.id, s.owner);
    await startPicking(s.order.id, s.owner);
    await removeItem(s.order.id, s.curdLine.id, s.owner, "Sold out");

    expect(await intentRow(s.intentId)).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedPaise: 4500 });
    expect(await balanceOf(s.customer.id)).toBe(0);
    const order = await orderRow(s.order.id);
    expect(order).toMatchObject({ status: "PREPARING", totalPaise: s.order.totalPaise - 4500, refundedPaise: 4500 });
    const [refund] = await db.select().from(orderRefunds).where(eq(orderRefunds.orderId, s.order.id));
    expect(refund).toMatchObject({ method: "ORIGINAL", paymentChannel: "ONLINE", status: "SUCCESS", amountPaise: 4500 });
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, s.customer.id), eq(notifications.title, "Item unavailable")));
    expect(told[0]?.body).toMatch(/original payment method/);

    const pick = await reconcileToday(s.admin);
    expect(pick(s.order.id)).toMatchObject({ status: "MATCHED", expectedPaise: order.totalPaise, actualPaise: order.totalPaise });
  });

  it("every line removed while gateway refunds are still pending: the order becomes REFUNDED only once the last refund settles", async () => {
    const s = await onlinePaidOrder();
    await acceptOrder(s.order.id, s.owner);
    await startPicking(s.order.id, s.owner);
    sandboxSettings.refundMode = "PENDING";
    await removeItem(s.order.id, s.milkLine.id, s.owner, "Sold out");
    await removeItem(s.order.id, s.curdLine.id, s.owner, "Sold out"); // the last line: the order is cancelled, the fee refunded
    expect((await orderRow(s.order.id)).status).toBe("REFUND_PENDING");

    const sent = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, s.intentId));
    expect(sent.map((r) => r.amountPaise).sort((a, b) => a - b)).toEqual([DELIVERY_FEE, 4500, 7000]);
    const intent = await intentRow(s.intentId);
    const settle = async (amountPaise: number) => {
      const refund = sent.find((r) => r.amountPaise === amountPaise)!;
      await sandbox.settleRefund(intent.gatewayOrderId!, refund.merchantRefundId, "SUCCESS");
      await runPaymentReconciliation();
    };
    await settle(DELIVERY_FEE); // the cancellation's refund first: two line refunds still on their way
    expect((await orderRow(s.order.id)).status).toBe("REFUND_PENDING");
    await settle(7000);
    expect((await orderRow(s.order.id)).status).toBe("REFUND_PENDING");
    await settle(4500);
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
    expect(await intentRow(s.intentId)).toMatchObject({ status: "REFUNDED", refundedPaise: intent.amountPaise });
    expect(await balanceOf(s.customer.id)).toBe(0);
  });

  it("cash on delivery: nothing was paid, so the line only lowers the amount to collect", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 0 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const curd = await createProduct(category.id, { name: "Curd", unit: "piece" });
    const shop = await createShop(owner.id, { name: "Cash Dairy" });
    await db.update(shops).set({ codEnabled: true }).where(eq(shops.id, shop.id));
    const a = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000 });
    const b = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 4500 });
    await addToCart(customer.id, a.id, 1);
    await addToCart(customer.id, b.id, 1);
    const { orders: [order] } = await checkout({
      userId: customer.id,
      requestId: `req-cod-${++seq}`,
      addressId: await deliveryAddressId(customer.id),
      paymentMethod: "COD",
    });
    const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
    await acceptOrder(order.id, shopActor);
    await startPicking(order.id, shopActor);
    const [curdLine] = await db.select().from(orderItems).where(and(eq(orderItems.orderId, order.id), eq(orderItems.lineTotalPaise, 4500)));
    await removeItem(order.id, curdLine.id, shopActor, "Sold out");
    expect(await orderRow(order.id)).toMatchObject({ status: "PREPARING", totalPaise: order.totalPaise - 4500, paidAt: null });
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await db.select().from(orderRefunds).where(eq(orderRefunds.orderId, order.id))).toHaveLength(0);
  });

  it("wallet-paid: unchanged — the line goes back to the wallet (the only line: then the fee, on cancel)", async () => {
    const s = await paidOrderAt("PREPARING");
    const before = await balanceOf(s.customer.id);
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, s.order.id));
    await removeItem(s.order.id, line.id, s.owner, "Sold out");
    expect(await balanceOf(s.customer.id)).toBe(before + s.order.totalPaise);
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
  });
});

/* ========================================================= money trace */

describe("TC-PAY-026: the money trace of an online-paid order shows the payment", () => {
  it("payment ONLINE with the gateway reference, and the intent's states CREATED → … → CAPTURED", async () => {
    const s = await onlinePaidOrder();
    const trace = await getOrderFinancialTrace(s.order.orderNumber);
    const intent = await intentRow(s.intentId);
    expect(trace.payment).toMatchObject({ method: "ONLINE", status: "CAPTURED", amountPaise: intent.amountPaise, intentId: intent.id });
    expect(trace.payment?.reference).toBe(intent.gatewayPaymentId);
    expect(trace.onlinePayments).toHaveLength(1);
    expect(trace.onlinePayments[0].events.map((e) => e.toStatus)).toEqual(expect.arrayContaining(["CREATED", "PENDING", "CAPTURED"]));
    // A wallet-paid order is unchanged.
    const wallet = await paidOrderAt("CONFIRMED");
    expect((await getOrderFinancialTrace(wallet.order.orderNumber)).payment).toMatchObject({ method: "WALLET" });
  });
});

/* ======================================================= subscriptions */

async function milkSubscription(options: { addressId?: string | null; startDate?: string } = {}) {
  const fixture = await createStandardMilkSetup();
  const subscription = await createSubscription({
    userId: fixture.customer.id,
    shopProductId: fixture.shopProduct.id,
    quantityMilli: 2000,
    frequency: "DAILY",
    startDate: options.startDate ?? addDays(TODAY(), 1),
    addressId: options.addressId ?? null,
  });
  return { ...fixture, subscription };
}

describe("TC-SUB-013: subscription deliveries carry the drop address", () => {
  it("a subscription with no address of its own is delivered to the customer's current default address", async () => {
    const s = await milkSubscription();
    const addressId = await deliveryAddressId(s.customer.id);
    const date = addDays(TODAY(), 1);
    const result = await generateDailyOrders(date, { subscriptionIds: [s.subscription.id] });
    expect(result.generated).toBe(1);
    const [order] = await db.select().from(orders).where(eq(orders.userId, s.customer.id));
    expect(order.addressId).toBe(addressId);
    expect(order.deliveryAddressSnapshot).toMatchObject({ line1: "2 Test Lane", city: "Pune", pincode: "411001" });
  });

  it("no address at all: no order, no charge, the day FAILED with reason NO_ADDRESS and the customer told", async () => {
    const s = await milkSubscription();
    const before = await balanceOf(s.customer.id);
    const date = addDays(TODAY(), 1);
    const result = await generateDailyOrders(date, { subscriptionIds: [s.subscription.id] });
    expect(result).toMatchObject({ generated: 0, noAddress: 1 });
    expect(await db.select().from(orders).where(eq(orders.userId, s.customer.id))).toHaveLength(0);
    expect(await balanceOf(s.customer.id)).toBe(before);
    const [day] = await db
      .select()
      .from(subscriptionDeliveries)
      .where(and(eq(subscriptionDeliveries.subscriptionId, s.subscription.id), eq(subscriptionDeliveries.deliveryDate, date)));
    expect(day).toMatchObject({ status: "FAILED", reason: "NO_ADDRESS" });
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, s.customer.id), eq(notifications.title, "Delivery address needed")));
    expect(note).toBeTruthy();
  });

  it("a subscription cannot point at someone else's address", async () => {
    const stranger = await createUser();
    const strangersAddress = await deliveryAddressId(stranger.id);
    await expect(milkSubscription({ addressId: strangersAddress })).rejects.toThrow(/saved delivery addresses/);
  });
});

describe("TC-SUB-008 / TC-FLD-107 / TC-FLD-108 / TC-FLD-109: subscription API checks", () => {
  async function signedInSubscriber() {
    const s = await milkSubscription({ startDate: TODAY() });
    signIn({ ...s.customer, role: "CUSTOMER" });
    return s;
  }
  const post = (body: Record<string, unknown>) => call(subscriptionsPost, "/api/subscriptions", { method: "POST", body });

  it("TC-SUB-008: a cancelled subscription refuses a PATCH (409) and keeps its quantity", async () => {
    const s = await signedInSubscriber();
    await cancelSubscription(s.subscription.id, "done", { id: s.customer.id, role: "CUSTOMER" });
    const patch = await call(subscriptionPatch, `/api/subscriptions/${s.subscription.id}`, {
      method: "PATCH",
      body: { quantityMilli: 3000 },
      params: { id: s.subscription.id },
    });
    expect(patch.status).toBe(409);
    const override = await call(overridePost, `/api/subscriptions/${s.subscription.id}/override`, {
      method: "POST",
      body: { date: addDays(TODAY(), 2), quantityMilli: 3000 },
      params: { id: s.subscription.id },
    });
    expect(override.status).toBe(409);
    expect((await db.query.subscriptions.findFirst({ where: (t, { eq: e }) => e(t.id, s.subscription.id) }))!.quantityMilli).toBe(2000);
  });

  it("TC-FLD-108: blank, 31 February, text and yesterday's start dates are 422; today is accepted", async () => {
    const s = await signedInSubscriber();
    const base = { shopProductId: s.shopProduct.id, quantityMilli: 1000, frequency: "DAILY", weekdays: [] };
    for (const startDate of ["", `${TODAY().slice(0, 4)}-02-31`, "tomorrow", addDays(TODAY(), -1)]) {
      const res = await post({ ...base, startDate });
      expect(res.status, startDate).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect((await post({ ...base, startDate: TODAY() })).status).toBe(201);
  });

  it("TC-FLD-109: skip, override, pause, retry and renew refuse blank / text / impossible dates with 422, never 500", async () => {
    const s = await signedInSubscriber();
    const id = s.subscription.id;
    const bad = ["", "next friday", `${TODAY().slice(0, 4)}-02-31`];
    for (const date of bad) {
      const at = (handler: (...a: never[]) => Promise<Response>, path: string, body: Record<string, unknown>) =>
        call(handler, `/api/subscriptions/${id}/${path}`, { method: "POST", body, params: { id } });
      expect((await at(skipPost, "skip", { date })).status, `skip ${date}`).toBe(422);
      expect((await at(overridePost, "override", { date, quantityMilli: 2000 })).status, `override ${date}`).toBe(422);
      expect((await at(pausePost, "pause", { from: date, until: addDays(TODAY(), 3) })).status, `pause ${date}`).toBe(422);
      expect((await at(retryPost, "retry", { date })).status, `retry ${date}`).toBe(422);
      expect((await at(renewPost, "renew", { endDate: date })).status, `renew ${date}`).toBe(422);
    }
    const ok = await call(skipPost, `/api/subscriptions/${id}/skip`, { method: "POST", body: { date: addDays(TODAY(), 3) }, params: { id } });
    expect(ok.status).toBe(200);
  });

  it("TC-FLD-107: quantities follow the page's 0.5 L step up to 50 L; 2.3 L, 50.5 L and 1000 L are refused", async () => {
    const s = await signedInSubscriber();
    const base = { shopProductId: s.shopProduct.id, frequency: "DAILY", weekdays: [], startDate: TODAY() };
    for (const quantityMilli of [2300, 50_500, 1_000_000, 250]) {
      expect((await post({ ...base, quantityMilli })).status, String(quantityMilli)).toBe(422);
    }
    for (const quantityMilli of [500, 2000, 50_000]) {
      expect((await post({ ...base, quantityMilli })).status, String(quantityMilli)).toBe(201);
    }
    const id = s.subscription.id;
    const override = await call(overridePost, `/api/subscriptions/${id}/override`, {
      method: "POST",
      body: { date: addDays(TODAY(), 2), quantityMilli: 2300 },
      params: { id },
    });
    expect(override.status).toBe(422);
    const patch = await call(subscriptionPatch, `/api/subscriptions/${id}`, { method: "PATCH", body: { quantityMilli: 2300 }, params: { id } });
    expect(patch.status).toBe(422);
  });
});

/* ===================================================== rider payouts */

describe("TC-COD-010: a negative rider payout is held and flagged", () => {
  it("gross + COD netting < 0: the payout is prepared, listed in the exceptions and cannot be approved, processed or paid", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const rider = await createDeliveryPartner((await createUser({ role: "DELIVERY_PARTNER" })).id);
    await db.insert(financialAdjustments).values([
      {
        type: "RIDER_ADJUSTMENT",
        party: "RIDER",
        status: "PENDING",
        deliveryPartnerId: rider.id,
        amountPaise: 5602,
        reason: "Trips this week",
        idempotencyKey: `qa-rider-earn-${rider.id}`,
      },
      {
        type: "COD_CASH_COLLECTED",
        party: "RIDER",
        status: "PENDING",
        deliveryPartnerId: rider.id,
        amountPaise: -200_800,
        reason: "Cash collected for a COD order",
        idempotencyKey: `qa-rider-cod-${rider.id}`,
      },
    ]);
    const today = TODAY();
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const monday = addDays(today, -(weekday - 1));
    const [payout] = await prepareRiderPayouts(monday, admin);
    expect(payout).toMatchObject({ deliveryPartnerId: rider.id, amountPaise: 5602 - 200_800, status: "PENDING" });

    const exceptions = await listFinancialExceptions("admin");
    expect(exceptions.batchProblems?.negativePayouts.map((p) => p.payout.id)).toContain(payout.id);
    await expect(decideRiderPayout(payout.id, "approve", admin)).rejects.toMatchObject({ code: "CONFLICT" });
    // Cancelling carries the amounts into the next week (the batch is not lost).
    await expect(decideRiderPayout(payout.id, "cancel", admin)).resolves.toMatchObject({ status: "CANCELLED" });
  });
});

/* ======================================================= notifications */

describe("TC-NTF-012: marking someone else's notification read", () => {
  it("answers 404 and leaves it unread; the caller's own answers 200", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const customer = await createUser();
    const [theirs] = await db.insert(notifications).values({ userId: owner.id, type: "shop.new_order", title: "New order", body: "x" }).returning();
    const [mine] = await db.insert(notifications).values({ userId: customer.id, type: "order.confirmed", title: "Confirmed", body: "y" }).returning();
    signIn({ ...customer, role: "CUSTOMER" });
    const other = await call(notificationsPatch, "/api/notifications", { method: "PATCH", body: { id: theirs.id } });
    expect(other.status).toBe(404);
    expect((await db.query.notifications.findFirst({ where: eq(notifications.id, theirs.id) }))!.readAt).toBeNull();
    const own = await call(notificationsPatch, "/api/notifications", { method: "PATCH", body: { id: mine.id } });
    expect(own).toMatchObject({ status: 200, body: { unreadCount: 0 } });
  });
});

/* ============================================================= wallet */

describe("TC-PAY-004: verifying an unpaid top-up", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("MOCK mode (no Cashfree keys): 400 PAYMENT_VERIFICATION_FAILED, Cashfree is never called, the top-up stays open", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const topUp = await createTopUpOrder(user.id, 1000);
    signIn({ ...user, role: "CUSTOMER" });
    const res = await call(verifyRoute, "/api/wallet/verify", { method: "POST", body: { gatewayOrderId: topUp.gatewayOrderId } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await db.query.payments.findFirst({ where: eq(payments.id, topUp.payment.id) }))!.status).toBe("CREATED");
  });

  it("Cashfree unreachable (fetch failed, ENOTFOUND): 400 with a try-again message, not 500; the payment is not marked FAILED", async () => {
    const env = getEnv() as { CASHFREE_APP_ID?: string };
    const before = env.CASHFREE_APP_ID;
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const topUp = await createTopUpOrder(user.id, 1000);
    await db.update(payments).set({ gateway: "CASHFREE" }).where(eq(payments.id, topUp.payment.id));
    env.CASHFREE_APP_ID = "test-app";
    try {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })));
      signIn({ ...user, role: "CUSTOMER" });
      const res = await call(verifyRoute, "/api/wallet/verify", { method: "POST", body: { gatewayOrderId: topUp.gatewayOrderId } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED", message: expect.stringMatching(/try again/) });
      expect((await db.query.payments.findFirst({ where: eq(payments.id, topUp.payment.id) }))!.status).toBe("CREATED");
      expect(await balanceOf(user.id)).toBe(0);
    } finally {
      env.CASHFREE_APP_ID = before;
    }
  });
});

describe("TC-FLD-032: the low-balance threshold has a ceiling", () => {
  it("₹70.50 and 0 are saved; ₹10 crore and decimal paise are 422", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    signIn({ ...user, role: "CUSTOMER" });
    const patch = (lowBalanceThresholdPaise: unknown) =>
      call(walletSettingsPatch, "/api/wallet/settings", { method: "PATCH", body: { lowBalanceThresholdPaise } });
    expect((await patch(7050)).status).toBe(200);
    expect((await patch(0)).status).toBe(200);
    const huge = await patch(10_000_000_000);
    expect(huge.status).toBe(422);
    expect(huge.body.error.message).toMatch(/at most/);
    expect((await patch(1055.5)).status).toBe(422);
    expect((await db.query.wallets.findFirst({ where: eq(wallets.userId, user.id) }))!.lowBalanceThresholdPaise).toBe(0);
  });
});

/* ============================================================ vouchers */

describe("TC-FLD-114: voucher budget and dates", () => {
  const future = () => addDays(TODAY(), 30);
  const base = () => ({ name: "Diwali bonus", bonusPercent: 10, startDate: TODAY(), endDate: future() });

  it("refuses a budget of 0, an end date already past and a budget smaller than one maximum bonus, naming the field", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn({ ...admin, role: "ADMIN" });
    const post = (body: Record<string, unknown>) => call(vouchersPost, "/api/vouchers", { method: "POST", body });

    const zero = await post({ ...base(), code: "ZERO1", totalBudgetPaise: 0 });
    expect(zero.status).toBe(422);
    expect(zero.body.error.details.fields).toHaveProperty("totalBudgetPaise");

    const past = await post({ ...base(), code: "PAST1", startDate: addDays(TODAY(), -10), endDate: addDays(TODAY(), -1) });
    expect(past.status).toBe(422);
    expect(past.body.error.details.fields).toHaveProperty("endDate");

    const small = await post({ ...base(), code: "SMALL1", maximumBonusPaise: 5000, totalBudgetPaise: 1000 });
    expect(small.status).toBe(422);
    expect(small.body.error.details.fields.totalBudgetPaise).toMatch(/smaller than one maximum bonus/);

    // A start date in the past with an end date ahead is fine, and so is no budget.
    const fine = await post({ ...base(), code: "FINE1", startDate: addDays(TODAY(), -3), maximumBonusPaise: 5000, totalBudgetPaise: 5000 });
    expect(fine.status).toBe(201);
    expect((await post({ ...base(), code: "NOBUDGET1" })).status).toBe(201);
  });

  it("an existing voucher whose start (or end) date has passed stays editable; a new past end date or a budget of 0 is refused", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const running = await createVoucherRow({ startDate: "2020-01-01", endDate: future() });
    await expect(updateVoucher(running.id, { bonusPercent: 15 }, admin)).resolves.toMatchObject({ bonusPercent: 15 });
    const ended = await createVoucherRow({ startDate: "2020-01-01", endDate: "2020-01-31" });
    await expect(updateVoucher(ended.id, { name: "Old campaign" }, admin)).resolves.toMatchObject({ name: "Old campaign" });
    // A voucher saved before the rule with a budget of 0 can still be edited for other fields.
    const legacy = await createVoucherRow({ endDate: future(), totalBudgetPaise: 0 });
    await expect(updateVoucher(legacy.id, { description: "Legacy" }, admin)).resolves.toMatchObject({ description: "Legacy" });

    await expect(updateVoucher(running.id, { endDate: addDays(TODAY(), -1) }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateVoucher(running.id, { totalBudgetPaise: 0 }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateVoucher(running.id, { maximumBonusPaise: 5000, totalBudgetPaise: 1000 }, admin)).rejects.toThrow(/smaller than one maximum bonus/);
    const row = (await db.query.vouchers.findFirst({ where: eq(vouchers.id, running.id) }))!;
    expect([row.endDate, row.totalBudgetPaise]).toEqual([future(), null]);
  });
});

/* ================================================= N1: every check type */

/** Monday of the current week (app time zone). */
function thisMonday(): string {
  const today = TODAY();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  return addDays(today, -(weekday - 1));
}

describe("N1 / TC-PAY-032: settlement, payout and gateway checks count their own lines", () => {
  it("SETTLEMENT_TOTAL and PAYOUT_TOTAL match when the books agree and are flagged with both amounts when altered", async () => {
    const s = await paidOrderAt("DELIVERED");
    await recordOrderFinancials(s.order.id);
    await db.update(orderFinancials).set({ deliveredAt: sql`now() - interval '10 days'` }).where(eq(orderFinancials.orderId, s.order.id));
    // A refund the shop bears, recorded last week: it must be counted in the settlement total.
    await db.insert(financialAdjustments).values({
      type: "REFUND_SHOP",
      party: "SHOP",
      status: "PENDING",
      shopId: s.shop.id,
      orderId: s.order.id,
      amountPaise: -4500,
      reason: "Refund after delivery",
      idempotencyKey: `qa-n1-refund-${s.order.id}`,
      createdAt: sql`now() - interval '8 days'` as unknown as Date,
    });
    const [settlement] = await prepareShopSettlements(previousWeekStart(), s.admin);
    expect(settlement.netPayablePaise).toBeLessThan(s.order.subtotalPaise);

    const rider = await createDeliveryPartner((await createUser({ role: "DELIVERY_PARTNER" })).id);
    await db.insert(deliveryPartnerEarnings).values([
      { deliveryPartnerId: rider.id, returnPickupId: crypto.randomUUID(), basePaise: 2000, distancePaise: 787, totalPaise: 2787 },
      { deliveryPartnerId: rider.id, returnPickupId: crypto.randomUUID(), basePaise: 2000, distancePaise: 1000, totalPaise: 3000 },
    ]);
    await db.insert(financialAdjustments).values({
      type: "RIDER_ADJUSTMENT",
      party: "RIDER",
      status: "PENDING",
      deliveryPartnerId: rider.id,
      amountPaise: 22_088,
      reason: "Waiting time",
      idempotencyKey: `qa-n1-rider-${rider.id}`,
    });
    const [payout] = await prepareRiderPayouts(thisMonday(), s.admin);
    expect(payout.amountPaise).toBe(27_875);

    let pick = await reconcileToday(s.admin);
    expect(pick(settlement.id, "SETTLEMENT_TOTAL")).toMatchObject({ status: "MATCHED", actualPaise: settlement.netPayablePaise });
    expect(pick(payout.id, "PAYOUT_TOTAL")).toMatchObject({ status: "MATCHED", expectedPaise: 27_875, actualPaise: 27_875 });

    await db.update(shopSettlements).set({ netPayablePaise: settlement.netPayablePaise + 100 }).where(eq(shopSettlements.id, settlement.id));
    await db.update(riderPayouts).set({ amountPaise: 27_975 }).where(eq(riderPayouts.id, payout.id));
    pick = await reconcileToday(s.admin);
    expect(pick(settlement.id, "SETTLEMENT_TOTAL")).toMatchObject({
      status: "EXCEPTION",
      expectedPaise: settlement.netPayablePaise + 100,
      actualPaise: settlement.netPayablePaise,
    });
    expect(pick(payout.id, "PAYOUT_TOTAL")).toMatchObject({ status: "EXCEPTION", expectedPaise: 27_975, actualPaise: 27_875 });
  });

  it("GATEWAY_CREDIT matches a credited top-up and is UNMATCHED when the credit is missing", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const credited = await createTopUpOrder(user.id, 10_000);
    await settleMockTopUp({
      userId: user.id,
      gatewayOrderId: credited.gatewayOrderId,
      gatewayPaymentId: "mock_pay_n1",
      signature: signForMock(credited.gatewayOrderId, "mock_pay_n1"),
    });
    // Gateway says paid, but no wallet credit was ever made.
    const missing = await createTopUpOrder(user.id, 20_000);
    await db.update(payments).set({ status: "SUCCESS" }).where(eq(payments.id, missing.payment.id));
    const pick = await reconcileToday(admin);
    expect(pick(credited.payment.id, "GATEWAY_CREDIT")).toMatchObject({ status: "MATCHED", expectedPaise: 10_000, actualPaise: 10_000 });
    expect(pick(missing.payment.id, "GATEWAY_CREDIT")).toMatchObject({ status: "UNMATCHED", expectedPaise: 20_000, actualPaise: 0 });
  });
});

/* =============================================== N2: refund after delivery */

describe("N2: a refund after delivery of an online-paid order goes back to the payment", () => {
  async function deliveredOnline() {
    const s = await onlinePaidOrder();
    await db.update(orders).set({ status: "DELIVERED" }).where(eq(orders.id, s.order.id));
    await recordOrderFinancials(s.order.id);
    return s;
  }

  it("a partial refund (one returned item) is sent to the gateway, not the wallet; the order stays DELIVERED", async () => {
    const s = await deliveredOnline();
    const adjustment = await refundDeliveredOrder(
      { orderNumber: s.order.orderNumber, amountPaise: 4500, reason: "Return RET-1", chargeTo: "SHOP", requestId: "return-qa-n2" },
      s.admin,
    );
    expect(adjustment).toMatchObject({ type: "REFUND_SHOP", customerRefundPaise: 4500, walletTransactionId: null });
    expect(await intentRow(s.intentId)).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedPaise: 4500 });
    const [sent] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, s.intentId));
    expect(sent).toMatchObject({ amountPaise: 4500, status: "SUCCESS", orderId: s.order.id });
    expect(await balanceOf(s.customer.id)).toBe(0);
    expect(await orderRow(s.order.id)).toMatchObject({ status: "DELIVERED", totalPaise: s.order.totalPaise - 4500 });
    // A replay of the same request refunds nothing more.
    await refundDeliveredOrder(
      { orderNumber: s.order.orderNumber, amountPaise: 4500, reason: "Return RET-1", chargeTo: "SHOP", requestId: "return-qa-n2" },
      s.admin,
    );
    expect((await intentRow(s.intentId)).refundedPaise).toBe(4500);
  });

  it("the admin full refund (POST /api/finance/refunds): REFUND_PENDING until the gateway confirms, then REFUNDED", async () => {
    const s = await deliveredOnline();
    const operator = await createUser({ role: "OPERATOR" });
    signIn({ ...operator, role: "OPERATOR" });
    const res = await call(financeRefundsPost, "/api/finance/refunds", {
      method: "POST",
      body: { orderNumber: s.order.orderNumber, amountPaise: s.order.totalPaise, reason: "Spoilt milk", chargeTo: "PLATFORM", requestId: "qa-n2-full-1" },
    });
    expect(res.status).toBe(201);
    expect(await intentRow(s.intentId)).toMatchObject({ status: "REFUNDED", refundedPaise: s.order.totalPaise });
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(0);
  });

  it("a wallet-paid order is unchanged: the wallet debit is reversed", async () => {
    const s = await paidOrderAt("DELIVERED");
    const before = await balanceOf(s.customer.id);
    await refundDeliveredOrder(
      { orderNumber: s.order.orderNumber, amountPaise: 1000, reason: "Short weight", chargeTo: "PLATFORM", requestId: "qa-n2-wallet" },
      s.admin,
    );
    expect(await balanceOf(s.customer.id)).toBe(before + 1000);
  });
});

/* ================================================= N6: substitution stock */

describe("N6 / TC-SPI-010: an approved substitute gives the original product's stock back", () => {
  it("P back to 10 (a return of this order in the movements), Q down by 1; cancelling afterwards restocks Q only", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const brandP = await createProduct(category.id, { name: "Brand P Milk", unit: "L" });
    const brandQ = await createProduct(category.id, { name: "Brand Q Milk", unit: "L" });
    const shop = await createShop(owner.id, { name: "Swap Dairy" });
    const p = await createShopProduct(shop.id, brandP.id, { onlinePricePaise: 3000, onlineStock: 10 });
    const q = await createShopProduct(shop.id, brandQ.id, { onlinePricePaise: 2800, onlineStock: 10 });
    await addToCart(customer.id, p.id, 1);
    const { orders: [order] } = await checkout({ userId: customer.id, requestId: `req-swap-${++seq}`, addressId: await deliveryAddressId(customer.id) });
    const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
    await acceptOrder(order.id, shopActor);
    await startPicking(order.id, shopActor);
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    await proposeSubstitution(order.id, line.id, q.id, shopActor);
    await decideSubstitution(order.id, line.id, { id: customer.id, role: "CUSTOMER" }, true);

    const stock = async (id: string) => (await db.query.shopProducts.findFirst({ where: eq(shopProducts.id, id) }))!.onlineStock;
    expect([await stock(p.id), await stock(q.id)]).toEqual([10, 9]);
    const back = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.shopProductId, p.id), eq(inventoryMovements.deltaUnits, 1)));
    expect(back).toHaveLength(1);
    expect(back[0].orderId).toBe(order.id);
    // The customer was charged the cheaper substitute: ₹2 back to the wallet.
    expect(await balanceOf(customer.id)).toBe(500_000 - order.totalPaise + 200);

    await cancelOrder(order.id, shopActor, "Shop closed early");
    expect([await stock(p.id), await stock(q.id)]).toEqual([10, 10]);
  });
});

/* ======================================================= field bounds */

describe("TC-FLD-112 / 113 / 116 / 117: money fields have a named ceiling", () => {
  it("registration fee: ₹10 crore 422, ₹70.50 and ₹0 accepted", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn({ ...admin, role: "ADMIN" });
    const post = (amountPaise: unknown) => call(registrationFeesPost, "/api/registration-fees", { method: "POST", body: { amountPaise, reason: "QA" } });
    expect((await post(10_000_000_000)).status).toBe(422);
    expect((await post(1055.5)).status).toBe(422);
    expect((await post(7050)).status).toBe(201);
    expect((await post(0)).status).toBe(201);
  });

  it("shop payment: ₹10 crore, a blank or reused reference and a future date are refused", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    const operator = await createUser({ role: "OPERATOR" });
    signIn({ ...operator, role: "OPERATOR" });
    const record = (body: Record<string, unknown>) =>
      call(shopPaymentsPost, "/api/shop-payments", { method: "POST", body: { shopId: shop.id, paymentType: "REGISTRATION_FEE", method: "UPI", ...body } });
    expect((await record({ amountPaise: 10_000_000_000, transactionId: "UPI-QA-1" })).status).toBe(422);
    const blank = await record({ amountPaise: 100 });
    expect(blank.status).toBe(422);
    expect(blank.body.error.details.fields).toHaveProperty("transactionId");
    expect((await record({ amountPaise: 100, transactionId: "UPI-QA-2", paidAt: new Date(Date.now() + 5 * 86_400_000).toISOString() })).status).toBe(422);
    const ok = await record({ amountPaise: 7050, transactionId: "UPI-QA-3", paidAt: new Date().toISOString() });
    expect(ok.status).toBe(201);
    expect((await record({ amountPaise: 100, transactionId: "upi-qa-3" })).status).toBe(409);
    // Cash needs no transaction reference (the receipt number is the payment's own reference).
    expect((await record({ amountPaise: 100, method: "CASH" })).status).toBe(201);
  });

  it("manual adjustment: ±10^10 paise refused, ₹70.50 accepted; COD deposit above the ceiling refused", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn({ ...admin, role: "ADMIN" });
    const shop = await createShop((await createUser({ role: "SHOP_OWNER" })).id);
    const adjust = (amountPaise: number) =>
      call(adjustmentsPost, "/api/finance/adjustments", {
        method: "POST",
        body: { type: "SHOP_ADJUSTMENT", shopId: shop.id, amountPaise, reason: "QA field check", requestId: `qa-adj-${amountPaise}-${++seq}` },
      });
    expect((await adjust(10_000_000_000)).status).toBe(422);
    expect((await adjust(-10_000_000_000)).status).toBe(422);
    expect((await adjust(7050)).status).toBe(201);
    const rider = await createDeliveryPartner((await createUser({ role: "DELIVERY_PARTNER" })).id);
    const deposit = await call(codDepositPost, "/api/admin/cod", {
      method: "POST",
      body: { party: "RIDER", id: rider.id, amountPaise: 10_000_000_000, reference: "RCPT-QA", requestId: "qa-deposit-1" },
    });
    expect(deposit.status).toBe(422);
  });
});

describe("TC-FLD-118: only a finished week is settled", () => {
  it("this week's and a future Monday are refused for shop settlements; last week's is prepared", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn({ ...admin, role: "ADMIN" });
    const prepare = (weekStart: string) => call(settlementsPost, "/api/finance/settlements", { method: "POST", body: { weekStart } });
    for (const weekStart of [thisMonday(), addDays(thisMonday(), 14)]) {
      const res = await prepare(weekStart);
      expect(res.status, weekStart).toBe(422);
      expect(res.body.error.details.fields).toHaveProperty("weekStart");
    }
    for (const weekStart of ["", "2026-02-31", "next monday", addDays(thisMonday(), -5)]) {
      expect((await prepare(weekStart)).status, weekStart).toBe(422);
    }
    expect((await prepare(addDays(thisMonday(), -7))).status).toBe(201);
    // Rider payouts may cover the week so far (COD netting), never a week not yet begun.
    const actor = { id: admin.id, role: "ADMIN" as const };
    await expect(prepareRiderPayouts(addDays(thisMonday(), 7), actor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(prepareRiderPayouts(thisMonday(), actor)).resolves.toEqual([]);
  });
});

describe("TC-SPI-004: the order-confirmed e-mail of an online-paid order has the same content", () => {
  it("lists each line, the delivery fee and the total once the payment is captured", async () => {
    const s = await onlinePaidOrder();
    const [mail] = await db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, s.customer.id),
          eq(notificationDeliveries.type, "order.confirmed"),
          eq(notificationDeliveries.channel, "EMAIL"),
        ),
      );
    expect(mail.body).toContain(`Your order ${s.order.orderNumber} from Online Dairy is confirmed.`);
    expect(mail.body).toContain("Cow Milk × 1 L: ₹70.00");
    expect(mail.body).toContain("Curd × 1 piece: ₹45.00");
    expect(mail.body).toContain("Delivery fee: ₹15.00");
    expect(mail.body).toContain("Total: ₹130.00");
  });
});
