/**
 * Event layer — risk rules per order: the high-value check runs the moment an
 * order is placed and the failed top-up check the moment a payment fails;
 * each new flag alerts support at once. The hourly scan stays for patterns.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { notifications, payments, riskFlags } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { checkout } from "@/server/services/orders";
import { checkRiskForUser, runRiskRules } from "@/server/services/risk";
import { clearRuleCache } from "@/server/services/settings";
import {
  createCategory,
  createPayment,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

const alertsFor = (userId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, NOTIFICATION_TYPES.RISK_FLAG_RAISED)));

describe("per-order risk checks", () => {
  it("a first order of ₹10,000+ is flagged at placement and support is alerted at once", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { user: customer } = await createUserWithWallet({ balancePaise: 5_000_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Ghee" });
    const ghee = await createProduct(category.id, { name: "Ghee tin", unit: "kg" });
    const shop = await createShop(owner.id);
    const sp = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 1_200_000, onlineStock: 5 });
    await addToCart(customer.id, sp.id, 1);
    await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });

    const flags = await db.select().from(riskFlags).where(eq(riskFlags.subjectId, customer.id));
    expect(flags.map((f) => f.ruleCode)).toEqual(["HIGH_VALUE_OUTLIER"]);
    expect(await alertsFor(operator.id)).toHaveLength(1);
  });

  it("repeated failed payments are flagged when the payment fails, once", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const customer = await createUser({ role: "CUSTOMER" });
    for (let i = 0; i < 5; i += 1) {
      const p = await createPayment(customer.id, { status: "CREATED" });
      await db.update(payments).set({ status: "FAILED" }).where(eq(payments.id, p.id));
    }
    expect(await checkRiskForUser(customer.id, "PAYMENT_FAILED")).toBe(1);
    expect(await checkRiskForUser(customer.id, "PAYMENT_FAILED")).toBe(0);
    expect(await alertsFor(operator.id)).toHaveLength(1);
  });

  it("a customer below every threshold raises nothing", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    expect(await checkRiskForUser(customer.id, "ORDER_PLACED")).toBe(0);
    expect(await checkRiskForUser(customer.id, "PAYMENT_FAILED")).toBe(0);
  });

  it("the hourly scan sends one summary alert for whatever it newly finds", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    for (const customer of [await createUser({ role: "CUSTOMER" }), await createUser({ role: "CUSTOMER" })]) {
      for (let i = 0; i < 5; i += 1) {
        const p = await createPayment(customer.id, { status: "CREATED" });
        await db.update(payments).set({ status: "FAILED" }).where(eq(payments.id, p.id));
      }
    }
    const result = await runRiskRules({ id: null, role: null });
    expect(result.raised).toBeGreaterThanOrEqual(2);
    const alerts = await alertsFor(operator.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("new flag");
  });
});
