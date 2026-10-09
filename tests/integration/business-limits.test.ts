/**
 * Item B — business limits that used to be fixed in code are rules in
 * Admin → Business rules. With the defaults untouched the behaviour (and the
 * wording) is exactly as before; an admin's change takes effect.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import { orderStatusHistory, orders, payments, platformSettings, riskFlags, grievances } from "@/server/db/schema";
import { getCodEligibility, assertCodAllowedForOrder, COD_LIMITS } from "@/server/services/cod";
import { getGrievanceDashboard } from "@/server/services/grievances";
import { createTopUpOrder } from "@/server/services/payments";
import { runRiskRules } from "@/server/services/risk";
import { clearRuleCache, listRules, setRule } from "@/server/services/settings";
import { createVoucher } from "@/server/services/vouchers";
import { createOrder, createPayment, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const KEYS = [
  "cod",
  "walletTopup",
  "ratings",
  "marketing",
  "vouchers",
  "settlement",
  "deliveryOtp",
  "returnPickup",
  "grievances",
  "discovery",
  "catalogue",
  "uploads",
  "opsExceptions",
  "riskRules",
] as const;

async function clearRules() {
  await db.delete(platformSettings).where(inArray(platformSettings.key, [...KEYS]));
  clearRuleCache();
}
beforeEach(async () => {
  await resetDatabase();
  await clearRules();
});
afterEach(clearRules);

async function admin() {
  const a = await createUser({ role: "ADMIN" });
  return { id: a.id, role: "ADMIN" as const };
}

describe("B — the new rules", () => {
  it("are listed on /admin/settings with the original values as defaults", async () => {
    const listed = await listRules();
    for (const key of KEYS) {
      const rule = listed.find((r) => r.key === key);
      expect(rule, key).toBeDefined();
      expect(rule!.overridden).toBe(false);
      expect(rule!.value).toEqual(RULES[key].defaults);
    }
    expect(RULES.cod.defaults).toEqual({ maxOrderPaise: 200_000, maxOpenOrders: 2, failureWindowDays: 90, maxFailures: 2 });
    expect(RULES.walletTopup.defaults).toEqual({ minPaise: 100, maxPaise: 10_000_000 });
    expect(RULES.settlement.defaults).toEqual({ holdDays: 2, missingAlertDays: 9 });
    expect(RULES.deliveryOtp.defaults).toEqual({ maxAttempts: 5 });
    expect(COD_LIMITS).toEqual(RULES.cod.defaults);
  });

  it("the original named settings are still there: 48 h return window, OTP, image limits, suspension policy", async () => {
    expect(RULES.returns.defaults.windowHours).toBe(48);
    expect(RULES.otp.defaults).toMatchObject({ length: 6, expiryMinutes: 10, maxAttempts: 5 });
    expect(RULES.images.defaults).toMatchObject({ maxBytes: 2_000_000, maxPerProduct: 8 });
    expect(RULES.suspension.defaults.actions.CONFIRMED).toBe("CANCEL_REFUND");
  });
});

describe("B — wallet top-up limits", () => {
  it("defaults: the same limits and messages as before", async () => {
    const user = await createUser();
    await expect(createTopUpOrder(user.id, 99)).rejects.toThrow("The minimum top-up is ₹1.");
    await expect(createTopUpOrder(user.id, 10_000_001)).rejects.toThrow("The maximum top-up is ₹1,00,000.");
  });

  it("an admin's change applies", async () => {
    const user = await createUser();
    await setRule("walletTopup", { minPaise: 5000, maxPaise: 500_000 }, await admin());
    await expect(createTopUpOrder(user.id, 4999)).rejects.toThrow("The minimum top-up is ₹50.");
    await expect(createTopUpOrder(user.id, 500_001)).rejects.toThrow("The maximum top-up is ₹5,000.");
  });

  it("refuses a minimum above the maximum", async () => {
    await expect(setRule("walletTopup", { minPaise: 600_000, maxPaise: 500_000 }, await admin())).rejects.toThrow();
  });
});

describe("B — COD limits", () => {
  it("defaults are applied by eligibility and the per-order check", async () => {
    const user = await createUser();
    const eligibility = await getCodEligibility(user.id);
    expect(eligibility).toMatchObject({ allowed: true, maxOrderPaise: 200_000, maxOpenOrders: 2 });
    const shop = { name: "Dairy", codEnabled: true, deliveryAvailable: true };
    expect(() => assertCodAllowedForOrder(shop, 200_001, eligibility.maxOrderPaise)).toThrow(
      "Cash on delivery is available up to ₹2,000.00 per order — Dairy's order is ₹2,000.01.",
    );
  });

  it("an admin's change applies", async () => {
    const user = await createUser();
    await setRule("cod", { maxOrderPaise: 50_000, maxOpenOrders: 5 }, await admin());
    const eligibility = await getCodEligibility(user.id);
    expect(eligibility).toMatchObject({ maxOrderPaise: 50_000, maxOpenOrders: 5 });
  });
});

describe("B — voucher bonus cap", () => {
  it("default 100 %; an admin can lower it", async () => {
    const a = await admin();
    const today = new Date().toISOString().slice(0, 10);
    const input = { name: "Big bonus", code: "BIG60", bonusPercent: 60, startDate: today, endDate: today };
    await setRule("vouchers", { maxBonusPercent: 50 }, a);
    await expect(createVoucher(input, a)).rejects.toThrow("at most 50%");
    await setRule("vouchers", { maxBonusPercent: 100 }, a);
    await expect(createVoucher(input, a)).resolves.toMatchObject({ code: "BIG60" });
  });
});

describe("B — grievance overdue days", () => {
  it("default 15 days; an admin's change applies", async () => {
    const user = await createUser();
    await db.insert(grievances).values({
      userId: user.id,
      name: "Customer",
      email: user.email,
      category: "OTHER",
      subject: "Late",
      description: "A grievance opened 10 days ago.",
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    } as typeof grievances.$inferInsert);
    expect((await getGrievanceDashboard()).overdue).toBe(0);
    await setRule("grievances", { overdueAfterDays: 7 }, await admin());
    expect((await getGrievanceDashboard()).overdue).toBe(1);
  });
});

describe("B — risk rules use the riskRules thresholds", () => {
  async function codFailures(userId: string, shopId: string, n: number) {
    for (let i = 0; i < n; i += 1) {
      const order = await createOrder(userId, shopId, { status: "FAILED" });
      await db.update(orders).set({ paymentMethod: "COD" }).where(eq(orders.id, order.id));
      await db.insert(orderStatusHistory).values({ orderId: order.id, previousStatus: "OUT_FOR_DELIVERY", newStatus: "FAILED" });
    }
  }
  const flagsFor = (subjectId: string, ruleCode: string) =>
    db.select().from(riskFlags).where(and(eq(riskFlags.subjectId, subjectId), eq(riskFlags.ruleCode, ruleCode)));

  it("every rule's query runs at the defaults (no flags on an empty database)", async () => {
    const result = await runRiskRules({ id: null, role: null });
    expect(result).toMatchObject({ raised: 0, refreshed: 0 });
  });

  it("COD_REFUSALS: 2 in 90 days by default (same wording); 1 is enough once lowered", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const twice = await createUser();
    const once = await createUser();
    await codFailures(twice.id, shop.id, 2);
    await codFailures(once.id, shop.id, 1);
    await runRiskRules({ id: null, role: null });
    const [flag] = await flagsFor(twice.id, "COD_REFUSALS");
    expect(flag.summary).toBe("2 cash-on-delivery orders failed or returned in 90 days");
    expect(await flagsFor(once.id, "COD_REFUSALS")).toHaveLength(0);

    await setRule("riskRules", { ...RULES.riskRules.defaults, codRefusals: { count: 1, days: 30 } }, await admin());
    await runRiskRules({ id: null, role: null });
    const [lowered] = await flagsFor(once.id, "COD_REFUSALS");
    expect(lowered.summary).toBe("1 cash-on-delivery orders failed or returned in 30 days");
  });

  it("TOPUP_FAILURES: 5 failed top-ups in 24 hours by default", async () => {
    const user = await createUser();
    for (let i = 0; i < 5; i += 1) {
      const p = await createPayment(user.id, { status: "CREATED" });
      await db.update(payments).set({ status: "FAILED" }).where(eq(payments.id, p.id));
    }
    await runRiskRules({ id: null, role: null });
    const [flag] = await flagsFor(user.id, "TOPUP_FAILURES");
    expect(flag.summary).toBe("5 failed wallet top-ups in 24 hours");
  });

  it("HIGH_VALUE_OUTLIER: the text built in SQL reads exactly as before at the defaults", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const user = await createUser();
    for (let i = 0; i < 3; i += 1) {
      const prior = await createOrder(user.id, shop.id, { status: "DELIVERED", subtotalPaise: 30_000 });
      await db.update(orders).set({ createdAt: new Date(Date.now() - (10 + i) * 86_400_000) }).where(eq(orders.id, prior.id));
    }
    const big = await createOrder(user.id, shop.id, { status: "CONFIRMED", subtotalPaise: 200_000 });
    await runRiskRules({ id: null, role: null });
    const [flag] = await flagsFor(user.id, "HIGH_VALUE_OUTLIER");
    expect(flag.summary).toBe(
      `An order in the last 7 days unusually large for this customer: ${big.orderNumber} for ₹2000.00 (6.7× their 90-day average of ₹300.00)`,
    );
  });
});
