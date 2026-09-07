/**
 * Daily subscription order engine (requirements §27, §33, §34, §39).
 *
 * Runs against real PostgreSQL. The idempotency and price-snapshot cases are the
 * reason this suite exists — they can only be proven against real constraints.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import {
  orderItems,
  orders,
  shopProducts,
  subscriptionOrders,
  subscriptions,
  walletTransactions,
  wallets,
} from "@/server/db/schema";
import {
  createSubscription,
  generateDailyOrders,
  getCalendar,
  getCostPreview,
  getWalletForecast,
  pauseSubscription,
  retryFailedDelivery,
  setDailyOverride,
  skipDate,
} from "@/server/services/subscriptions";
import { applyWalletMutation } from "@/server/services/wallet";
import { createStandardMilkSetup, resetDatabase } from "../helpers/fixtures";

/**
 * Anchored to today, not fixed calendar dates. `setDailyOverride` and
 * `skipDate` refuse to touch a delivery in the past, so hardcoded dates make
 * this suite start failing the day they age out — which is exactly what
 * happened to the previous 2026-08-20 constants.
 */
const DAY_1 = addDays(todayIn(getEnv().APP_TIMEZONE), 1);
const DAY_2 = addDays(DAY_1, 1);
const DAY_3 = addDays(DAY_2, 1);

/** ₹70/L × 2 L = ₹140 */
const DAILY_COST = 14_000;

async function setup(balancePaise = 500_000) {
  const fixture = await createStandardMilkSetup({
    customerBalancePaise: balancePaise,
  });
  const subscription = await createSubscription({
    userId: fixture.customer.id,
    shopProductId: fixture.shopProduct.id,
    quantityMilli: 2000, // 2 L/day
    frequency: "DAILY",
    startDate: DAY_1,
  });
  return { ...fixture, subscription };
}

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!
    .balancePaise;

beforeEach(resetDatabase);

describe("daily generation — the milk scenario (§27)", () => {
  it("creates one order and deducts 2 L × ₹70 = ₹140", async () => {
    const { customer, subscription } = await setup();

    const result = await generateDailyOrders(DAY_1);

    expect(result.generated).toBe(1);
    expect(await balanceOf(customer.id)).toBe(500_000 - DAILY_COST);

    const [subOrder] = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(subOrder.quantityMilli).toBe(2000);
    expect(subOrder.unitPricePaise).toBe(7000);
    expect(subOrder.totalPaise).toBe(DAILY_COST);
    expect(subOrder.status).toBe("CONFIRMED");

    const order = await db.query.orders.findFirst({
      where: eq(orders.id, subOrder.orderId!),
    });
    expect(order?.status).toBe("CONFIRMED");
    expect(order?.source).toBe("SUBSCRIPTION");
    expect(order?.paidAt).not.toBeNull();
  });

  it("charges ₹210 when tomorrow is changed to 3 L (§28)", async () => {
    const { customer, subscription } = await setup();

    await setDailyOverride(subscription.id, DAY_2, 3000, {
      id: customer.id,
      role: "CUSTOMER",
    });

    await generateDailyOrders(DAY_1); // standard 2 L → ₹140
    await generateDailyOrders(DAY_2); // override 3 L → ₹210

    expect(await balanceOf(customer.id)).toBe(500_000 - 14_000 - 21_000);

    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    const byDate = Object.fromEntries(
      rows.map((r) => [r.deliveryDate, r.totalPaise]),
    );
    expect(byDate[DAY_1]).toBe(14_000);
    expect(byDate[DAY_2]).toBe(21_000);
  });

  it("returns to the standing quantity the day after an override", async () => {
    const { customer, subscription } = await setup();
    await setDailyOverride(subscription.id, DAY_2, 3000, {
      id: customer.id,
      role: "CUSTOMER",
    });

    await generateDailyOrders(DAY_1);
    await generateDailyOrders(DAY_2);
    await generateDailyOrders(DAY_3);

    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    const byDate = Object.fromEntries(
      rows.map((r) => [r.deliveryDate, r.quantityMilli]),
    );
    expect([byDate[DAY_1], byDate[DAY_2], byDate[DAY_3]]).toEqual([
      2000, 3000, 2000,
    ]);
  });
});

describe("idempotency (§33)", () => {
  it("running the job twice for the same day changes nothing", async () => {
    const { customer, subscription } = await setup();

    const first = await generateDailyOrders(DAY_1);
    const second = await generateDailyOrders(DAY_1);

    expect(first.generated).toBe(1);
    expect(second.generated).toBe(0);
    expect(second.alreadyExisted).toBe(1);

    expect(await balanceOf(customer.id)).toBe(500_000 - DAILY_COST);

    const subOrders = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(subOrders).toHaveLength(1);

    const txns = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, customer.id));
    expect(txns).toHaveLength(1);
  });

  it("survives five concurrent runs of the same day", async () => {
    const { customer, subscription } = await setup();

    await Promise.all(
      Array.from({ length: 5 }, () => generateDailyOrders(DAY_1)),
    );

    const subOrders = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(subOrders).toHaveLength(1);

    const allOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, customer.id));
    expect(allOrders).toHaveLength(1);

    expect(await balanceOf(customer.id)).toBe(500_000 - DAILY_COST);
  });
});

describe("skip and pause (§30, §31)", () => {
  it("a skipped day produces no order and no deduction", async () => {
    const { customer, subscription } = await setup();

    await skipDate(subscription.id, DAY_2, { id: customer.id, role: "CUSTOMER" });

    await generateDailyOrders(DAY_1);
    const skipped = await generateDailyOrders(DAY_2);

    expect(skipped.generated).toBe(0);
    expect(skipped.skipped).toBe(1);
    expect(await balanceOf(customer.id)).toBe(500_000 - DAILY_COST);

    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(
        and(
          eq(subscriptionOrders.subscriptionId, subscription.id),
          eq(subscriptionOrders.deliveryDate, DAY_2),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("a paused window produces no orders and no deductions", async () => {
    const { customer, subscription } = await setup();

    await pauseSubscription(subscription.id, DAY_1, DAY_3, {
      id: customer.id,
      role: "CUSTOMER",
    });

    for (const day of [DAY_1, DAY_2, DAY_3]) {
      const r = await generateDailyOrders(day);
      expect(r.generated).toBe(0);
    }

    expect(await balanceOf(customer.id)).toBe(500_000);
    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(rows).toHaveLength(0);
  });
});

describe("price changes (§34)", () => {
  it("uses the new price for future days and never rewrites past orders", async () => {
    const { customer, subscription, shopProduct } = await setup();

    await generateDailyOrders(DAY_1); // at ₹70 → ₹140

    // Shop raises the price to ₹72/L.
    await db
      .update(shopProducts)
      .set({ onlinePricePaise: 7200 })
      .where(eq(shopProducts.id, shopProduct.id));

    await generateDailyOrders(DAY_2); // at ₹72 → ₹144

    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    const byDate = Object.fromEntries(
      rows.map((r) => [r.deliveryDate, r.unitPricePaise]),
    );

    // Day 1 keeps its historical price; day 2 picks up the new one.
    expect(byDate[DAY_1]).toBe(7000);
    expect(byDate[DAY_2]).toBe(7200);
    expect(await balanceOf(customer.id)).toBe(500_000 - 14_000 - 14_400);

    // The order line snapshot is likewise frozen.
    const day1Order = rows.find((r) => r.deliveryDate === DAY_1)!;
    const [item] = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, day1Order.orderId!));
    expect(item.unitPricePaise).toBe(7000);
    expect(item.lineTotalPaise).toBe(14_000);
  });
});

describe("insufficient balance (§39)", () => {
  it("does not deduct, marks the day WALLET_INSUFFICIENT, and allows a retry", async () => {
    // ₹100 available but the day costs ₹140.
    const { customer, subscription } = await setup(10_000);

    const result = await generateDailyOrders(DAY_1);
    expect(result.walletFailures).toBe(1);
    expect(result.generated).toBe(0);

    // Nothing was taken.
    expect(await balanceOf(customer.id)).toBe(10_000);
    const txns = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, customer.id));
    expect(txns).toHaveLength(0);

    const [failed] = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(failed.status).toBe("WALLET_INSUFFICIENT");

    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription.id),
    });
    expect(sub?.status).toBe("PAYMENT_PENDING");

    // Customer tops up and retries.
    await applyWalletMutation({
      userId: customer.id,
      amountPaise: 100_000,
      type: "TOP_UP",
      idempotencyKey: "topup-after-failure",
      description: "Top-up",
    });

    const outcome = await retryFailedDelivery(subscription.id, DAY_1);
    expect(outcome).toBe("GENERATED");
    expect(await balanceOf(customer.id)).toBe(110_000 - DAILY_COST);

    const [retried] = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(retried.status).toBe("CONFIRMED");
  });

  it("a failed day is still claimed, so re-running the job does not double-charge", async () => {
    const { customer, subscription } = await setup(10_000);

    await generateDailyOrders(DAY_1);
    const rerun = await generateDailyOrders(DAY_1);

    expect(rerun.alreadyExisted).toBe(1);
    expect(await balanceOf(customer.id)).toBe(10_000);

    const rows = await db
      .select()
      .from(subscriptionOrders)
      .where(eq(subscriptionOrders.subscriptionId, subscription.id));
    expect(rows).toHaveLength(1);
  });
});

describe("calendar, preview and forecast (§35–§37)", () => {
  it("projects the calendar with overrides and skips applied", async () => {
    const { customer, subscription } = await setup();

    await setDailyOverride(subscription.id, DAY_2, 3000, {
      id: customer.id,
      role: "CUSTOMER",
    });
    await skipDate(subscription.id, DAY_3, {
      id: customer.id,
      role: "CUSTOMER",
    });

    const calendar = await getCalendar(subscription.id, 4, DAY_1);
    expect(calendar.map((d) => [d.date, d.quantityMilli])).toEqual([
      [DAY_1, 2000],
      [DAY_2, 3000],
      [DAY_3, 0],
      [addDays(DAY_3, 1), 2000],
    ]);
    expect(calendar[1].estimatedCostPaise).toBe(21_000);
    expect(calendar[2].delivers).toBe(false);
    expect(calendar[2].reason).toBe("SKIPPED");
  });

  it("previews daily, 7-day and 30-day cost", async () => {
    const { shopProduct } = await createStandardMilkSetup();
    const preview = await getCostPreview(shopProduct.id, 2000, "DAILY");

    expect(preview.dailyCostPaise).toBe(14_000); // ₹140
    expect(preview.sevenDayCostPaise).toBe(98_000); // ₹980
    expect(preview.thirtyDayCostPaise).toBe(420_000); // ₹4,200
  });

  it("flags a shortfall and recommends a top-up", async () => {
    // The forecast window runs from today, so start the subscription today to
    // make the day count deterministic regardless of when the suite runs.
    const today = todayIn(getEnv().APP_TIMEZONE);
    const fixture = await createStandardMilkSetup({
      customerBalancePaise: 120_000, // ₹1,200
    });
    await createSubscription({
      userId: fixture.customer.id,
      shopProductId: fixture.shopProduct.id,
      quantityMilli: 2000,
      frequency: "DAILY",
      startDate: today,
    });

    // 15 days × ₹140 = ₹2,100 against a ₹1,200 balance.
    const forecast = await getWalletForecast(fixture.customer.id, 15);
    expect(forecast.upcomingCostPaise).toBe(15 * DAILY_COST);
    expect(forecast.sufficient).toBe(false);
    expect(forecast.shortfallPaise).toBe(15 * DAILY_COST - 120_000);
    // Rounded up to a whole ₹100 so the suggestion clears the gap.
    expect(forecast.recommendedTopUpPaise % 10_000).toBe(0);
    expect(forecast.recommendedTopUpPaise).toBeGreaterThanOrEqual(
      forecast.shortfallPaise,
    );
  });

  it("excludes days before the subscription starts", async () => {
    const today = todayIn(getEnv().APP_TIMEZONE);
    const fixture = await createStandardMilkSetup({
      customerBalancePaise: 500_000,
    });
    // Starts in 3 days, so a 10-day window covers only 7 deliveries.
    await createSubscription({
      userId: fixture.customer.id,
      shopProductId: fixture.shopProduct.id,
      quantityMilli: 2000,
      frequency: "DAILY",
      startDate: addDays(today, 3),
    });

    const forecast = await getWalletForecast(fixture.customer.id, 10);
    expect(forecast.upcomingCostPaise).toBe(7 * DAILY_COST);
  });
});
