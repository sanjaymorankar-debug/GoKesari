/**
 * SM-004 — subscription states (DRAFT, RENEWAL_PENDING) and the status of
 * each delivery (subscription_deliveries, migration 0052).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { isAllowedDeliveryTransition, SUBSCRIPTION_DELIVERY_STATUSES } from "@/lib/subscription-deliveries";
import { db } from "@/server/db";
import { orders, platformSettings, subscriptionDeliveries, subscriptionOrders, subscriptions } from "@/server/db/schema";
import { updateOrderStatus } from "@/server/services/orders";
import { createTopUpOrder, settleMockTopUp, signForMock } from "@/server/services/payments";
import { clearRuleCache } from "@/server/services/settings";
import { isLifecycleTransitionError } from "@/server/services/status-models";
import { evaluateRenewals, renewSubscription } from "@/server/services/subscription-renewal";
import { syncSubscriptionSchedule } from "@/server/services/subscription-schedule";
import {
  activateSubscription,
  cancelSubscription,
  createSubscription,
  generateDailyOrders,
  pauseSubscription,
  resumeSubscription,
  retryFailedDelivery,
  skipDate,
} from "@/server/services/subscriptions";
import { applyWalletMutation } from "@/server/services/wallet";
import { createStandardMilkSetup, resetDatabase } from "../helpers/fixtures";

const TODAY = todayIn(getEnv().APP_TIMEZONE);
const DAY = (n: number) => addDays(TODAY, n);
/** ₹70/L × 2 L */
const DAILY_COST = 14_000;

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "subscriptionRenewal"));
  clearRuleCache();
});

async function setup(options: { balancePaise?: number; draft?: boolean; startDate?: string; endDate?: string | null } = {}) {
  const fixture = await createStandardMilkSetup({ customerBalancePaise: options.balancePaise ?? 500_000 });
  const subscription = await createSubscription({
    userId: fixture.customer.id,
    shopProductId: fixture.shopProduct.id,
    quantityMilli: 2000,
    frequency: "DAILY",
    startDate: options.startDate ?? TODAY,
    endDate: options.endDate ?? null,
    draft: options.draft,
  });
  const actor = { id: fixture.customer.id, role: "CUSTOMER" as const };
  return { ...fixture, subscription, actor };
}

async function deliveries(subscriptionId: string) {
  return db
    .select()
    .from(subscriptionDeliveries)
    .where(eq(subscriptionDeliveries.subscriptionId, subscriptionId))
    .orderBy(subscriptionDeliveries.deliveryDate);
}

async function sub(id: string) {
  return (await db.query.subscriptions.findFirst({ where: eq(subscriptions.id, id) }))!;
}

describe("DRAFT", () => {
  it("schedules and charges nothing until activated", async () => {
    const { subscription, actor, customer } = await setup({ draft: true });
    expect(subscription.status).toBe("DRAFT");
    expect(subscription.lifecycleStatus).toBe("DRAFT");
    expect(subscription.nextDeliveryDate).toBeNull();
    expect(await deliveries(subscription.id)).toHaveLength(0);

    const run = await generateDailyOrders(TODAY);
    expect(run.generated).toBe(0);
    expect(await db.select().from(orders).where(eq(orders.userId, customer.id))).toHaveLength(0);

    await expect(pauseSubscription(subscription.id, DAY(1), DAY(2), actor)).rejects.toMatchObject({ code: "CONFLICT" });

    const active = await activateSubscription(subscription.id, actor);
    expect(active.status).toBe("ACTIVE");
    expect(active.lifecycleStatus).toBe("ACTIVE");
    const rows = await deliveries(subscription.id);
    expect(rows.length).toBe(7); // default horizon
    expect(rows.every((r) => r.status === "SCHEDULED" && r.quantityMilli === 2000)).toBe(true);
  });

  it("can be discarded, and nothing moves a subscription back to DRAFT", async () => {
    const { subscription, actor } = await setup({ draft: true });
    const discarded = await cancelSubscription(subscription.id, "Changed my mind", actor);
    expect(discarded.lifecycleStatus).toBe("CANCELLED");

    const other = await setup();
    await expect(
      db.update(subscriptions).set({ status: "DRAFT" }).where(eq(subscriptions.id, other.subscription.id)),
    ).rejects.toSatisfy(isLifecycleTransitionError);
  });
});

describe("each delivery carries its own status", () => {
  it("SCHEDULED → the order's status, following the order all the way to DELIVERED", async () => {
    const { subscription, owner } = await setup();
    await generateDailyOrders(TODAY);

    const [todayRow] = (await deliveries(subscription.id)).filter((r) => r.deliveryDate === TODAY);
    expect(todayRow.status).toBe("CONFIRMED");
    expect(todayRow.orderId).not.toBeNull();

    const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
    await updateOrderStatus(todayRow.orderId!, "ACCEPTED", shopActor);
    await updateOrderStatus(todayRow.orderId!, "PREPARING", shopActor);
    await updateOrderStatus(todayRow.orderId!, "READY", shopActor);
    const [afterReady] = await db.select().from(subscriptionDeliveries).where(eq(subscriptionDeliveries.id, todayRow.id));
    expect(afterReady.status).toBe("READY");
    // subscription_orders follows the order too (it used to stay CONFIRMED).
    const [subOrder] = await db.select().from(subscriptionOrders).where(eq(subscriptionOrders.orderId, todayRow.orderId!));
    expect(subOrder.status).toBe("READY");

    // Tomorrow is still only scheduled.
    const tomorrow = (await deliveries(subscription.id)).find((r) => r.deliveryDate === DAY(1));
    expect(tomorrow?.status).toBe("SCHEDULED");
  });

  it("is SKIPPED for a skipped date or a pause, and SCHEDULED again on resume", async () => {
    const { subscription, actor } = await setup();
    await skipDate(subscription.id, DAY(1), actor);
    await pauseSubscription(subscription.id, DAY(3), DAY(4), actor);
    let rows = await deliveries(subscription.id);
    const at = (d: string) => rows.find((r) => r.deliveryDate === d);
    expect(at(DAY(1))).toMatchObject({ status: "SKIPPED", reason: "SKIPPED_BY_CUSTOMER" });
    expect(at(DAY(2))).toMatchObject({ status: "SCHEDULED" });
    expect(at(DAY(3))).toMatchObject({ status: "SKIPPED", reason: "PAUSED" });

    await resumeSubscription(subscription.id, actor);
    rows = await deliveries(subscription.id);
    expect(at(DAY(3))?.status).toBe("SCHEDULED");
    expect(at(DAY(1))?.status).toBe("SKIPPED");
  });

  it("records a wallet failure, then the retried order", async () => {
    const { subscription, customer } = await setup({ balancePaise: 0 });
    await generateDailyOrders(TODAY);
    let [row] = (await deliveries(subscription.id)).filter((r) => r.deliveryDate === TODAY);
    expect(row.status).toBe("WALLET_INSUFFICIENT");

    await applyWalletMutation({
      userId: customer.id,
      amountPaise: 100_000,
      type: "MANUAL_CREDIT",
      idempotencyKey: `test-credit-${customer.id}`,
      description: "test",
    });
    await retryFailedDelivery(subscription.id, TODAY);
    [row] = (await deliveries(subscription.id)).filter((r) => r.deliveryDate === TODAY);
    expect(row.status).toBe("CONFIRMED");
  });

  it("is FAILED (unavailable) when the product cannot be sold that day", async () => {
    const { subscription, shopProduct } = await setup();
    await db.execute(sql`UPDATE shop_products SET online_sale_enabled = false WHERE id = ${shopProduct.id}`);
    await generateDailyOrders(TODAY);
    const [row] = (await deliveries(subscription.id)).filter((r) => r.deliveryDate === TODAY);
    expect(row).toMatchObject({ status: "FAILED", reason: "UNAVAILABLE", orderId: null });
  });

  it("never goes back from an order status to SCHEDULED (enforced by the database)", async () => {
    const { subscription } = await setup();
    await generateDailyOrders(TODAY);
    const update = db
      .update(subscriptionDeliveries)
      .set({ status: "SCHEDULED" })
      .where(and(eq(subscriptionDeliveries.subscriptionId, subscription.id), eq(subscriptionDeliveries.deliveryDate, TODAY)));
    await expect(update).rejects.toSatisfy(isLifecycleTransitionError);
  });

  it("drops upcoming scheduled rows when the subscription is cancelled", async () => {
    const { subscription, actor } = await setup();
    await generateDailyOrders(TODAY);
    await cancelSubscription(subscription.id, "Moving away", actor);
    const rows = await deliveries(subscription.id);
    expect(rows.map((r) => r.status)).toEqual(["CONFIRMED"]); // today's order stays
  });

  it("SQL transition rule matches the TypeScript one for every pair", async () => {
    for (const from of SUBSCRIPTION_DELIVERY_STATUSES) {
      for (const to of SUBSCRIPTION_DELIVERY_STATUSES) {
        const [{ ok }] = (await db.execute(
          sql`SELECT subscription_delivery_transition_ok(${from}, ${to}) AS ok`,
        )) as unknown as { ok: boolean }[];
        expect([from, to, ok]).toEqual([from, to, isAllowedDeliveryTransition(from, to)]);
      }
    }
  });
});

describe("RENEWAL_PENDING — term end", () => {
  it("flags a subscription ending within the notice period; deliveries continue; renewing extends the term", async () => {
    const { subscription, actor } = await setup({ startDate: TODAY, endDate: DAY(2) });
    const result = await evaluateRenewals(TODAY);
    expect(result.termEnd).toBe(1);
    let row = await sub(subscription.id);
    expect(row).toMatchObject({ status: "RENEWAL_PENDING", renewalReason: "TERM_END", renewalDueDate: DAY(2), lifecycleStatus: "RENEWAL_PENDING" });

    const run = await generateDailyOrders(TODAY);
    expect(run.generated).toBe(1);
    expect((await sub(subscription.id)).status).toBe("RENEWAL_PENDING");

    await renewSubscription(subscription.id, {}, actor);
    row = await sub(subscription.id);
    // Same term length again (3 days, at least 7): ends 7 days after the old end.
    expect(row).toMatchObject({ status: "ACTIVE", renewalReason: null, endDate: DAY(9) });
  });

  it("renewing with no end date keeps it going", async () => {
    const { subscription, actor } = await setup({ endDate: DAY(1) });
    await evaluateRenewals(TODAY);
    const renewed = await renewSubscription(subscription.id, { endDate: null }, actor);
    expect(renewed).toMatchObject({ status: "ACTIVE", endDate: null });
  });

  it("completes once the end date has passed (lifecycle EXPIRED) and clears the schedule", async () => {
    const { subscription } = await setup({ startDate: DAY(-5), endDate: DAY(-1) });
    await syncSubscriptionSchedule(subscription.id, { from: TODAY });
    const result = await evaluateRenewals(TODAY);
    expect(result.completed).toBe(1);
    const row = await sub(subscription.id);
    expect(row).toMatchObject({ status: "COMPLETED", lifecycleStatus: "EXPIRED", nextDeliveryDate: null });
    expect(await deliveries(subscription.id)).toHaveLength(0);
  });

  it("is off when the rule says so", async () => {
    await db.insert(platformSettings).values({ key: "subscriptionRenewal", value: { termEndEnabled: false } });
    clearRuleCache();
    const { subscription } = await setup({ endDate: DAY(1) });
    await evaluateRenewals(TODAY);
    expect((await sub(subscription.id)).status).toBe("ACTIVE");
  });
});

describe("RENEWAL_PENDING — payment due", () => {
  it("flags a wallet that will not cover tomorrow, refuses renewal until topped up, and clears on top-up", async () => {
    const { subscription, actor, customer } = await setup({ balancePaise: DAILY_COST });
    await generateDailyOrders(TODAY); // today's delivery takes the whole balance
    let row = await sub(subscription.id);
    expect(row).toMatchObject({ status: "RENEWAL_PENDING", renewalReason: "PAYMENT_DUE", renewalDueDate: DAY(1) });

    await expect(renewSubscription(subscription.id, {}, actor)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Add ₹140.00"),
    });

    // A real (mock-gateway) top-up clears it straight away.
    const intent = await createTopUpOrder(customer.id, 50_000);
    const paymentId = `mock_pay_${intent.gatewayOrderId.slice(-12)}`;
    await settleMockTopUp({
      userId: customer.id,
      gatewayOrderId: intent.gatewayOrderId,
      gatewayPaymentId: paymentId,
      signature: signForMock(intent.gatewayOrderId, paymentId),
    });
    row = await sub(subscription.id);
    expect(row).toMatchObject({ status: "ACTIVE", renewalReason: null, renewalDueDate: null });
  });

  it("leaves a subscription whose term is ending as TERM_END", async () => {
    const { subscription } = await setup({ balancePaise: 0, endDate: DAY(2) });
    await evaluateRenewals(TODAY);
    expect((await sub(subscription.id)).renewalReason).toBe("TERM_END");
  });
});
