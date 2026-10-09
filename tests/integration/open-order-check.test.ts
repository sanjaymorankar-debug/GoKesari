/**
 * C3 — (1) the duplicate check when a shop adds a product may show other
 * shops' pending products (decision: allowed; pinned here). (2) A customer
 * with an existing open order is shown it before paying, with whether they
 * may cancel it themselves (rule openOrderCheck; cancellation via the
 * existing D10 path).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orders, platformSettings, products } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { createProductForShop, findSimilarProducts } from "@/server/services/catalogue";
import { acceptOrder } from "@/server/services/fulfilment";
import { cancelOrder, checkout, listOpenOrdersForCheckout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
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

async function clearRules() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "openOrderCheck"));
  await db.delete(platformSettings).where(eq(platformSettings.key, "cancellation"));
  clearRuleCache();
}
beforeEach(async () => {
  await resetDatabase();
  await clearRules();
});
afterEach(clearRules);

describe("C3 — duplicate check shows other shops' pending products", () => {
  it("a product another shop added (still pending approval) is offered as a likely duplicate", async () => {
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const pending = await createProduct(category.id, { name: "Kesari Fresh Paneer" });
    await db.update(products).set({ approvalStatus: "PENDING_APPROVAL" }).where(eq(products.id, pending.id));

    const { similar } = await findSimilarProducts("Kesari Fresh Paneer 200g", category.id);
    expect(similar.map((p) => p.id)).toContain(pending.id);

    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    await expect(
      createProductForShop(
        { shopId: shop.id, categoryId: category.id, name: "Kesari Fresh Paneer 200g", unit: "piece" },
        { id: owner.id, role: "SHOP_OWNER" },
        true,
      ),
    ).rejects.toThrow(/Kesari Fresh Paneer/);
  });
});

async function placeOrder(customerId: string, shopId: string, productId: string) {
  const sp = await createShopProduct(shopId, productId, { onlinePricePaise: 5000, onlineStock: 50 });
  await addToCart(customerId, sp.id, 1);
  const { orders: created } = await checkout({
    userId: customerId,
    requestId: `req-${shopId}-${Math.random()}`,
    addressId: await deliveryAddressId(customerId),
  });
  return created[0];
}

async function setup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const otherOwner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk" });
  const curd = await createProduct(category.id, { name: "Curd", unit: "kg" });
  const shopA = await createShop(owner.id, { name: "Shop A" });
  const shopB = await createShop(otherOwner.id, { name: "Shop B" });
  return { customer, owner, admin, shopA, shopB, milk, curd };
}

describe("C3 — open order prompt", () => {
  it("lists the customer's open order with its status; CONFIRMED is self-cancellable", async () => {
    const s = await setup();
    const order = await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    const open = await listOpenOrdersForCheckout(s.customer.id, [s.shopB.id]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: order.id,
      orderNumber: order.orderNumber,
      shopName: "Shop A",
      status: "CONFIRMED",
      statusLabel: "Confirmed",
      customerMayCancel: true,
    });
  });

  it("an accepted order is shown but not self-cancellable by default; is with cancellation rule PREPARING", async () => {
    const s = await setup();
    const order = await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    await acceptOrder(order.id, { id: s.owner.id, role: "SHOP_OWNER" });
    let [open] = await listOpenOrdersForCheckout(s.customer.id, []);
    expect(open).toMatchObject({ status: "ACCEPTED", statusLabel: "Accepted by shop", customerMayCancel: false });
    await setRule("cancellation", { customerMayCancelUntil: "PREPARING" }, { id: s.admin.id, role: "ADMIN" });
    [open] = await listOpenOrdersForCheckout(s.customer.id, []);
    expect(open.customerMayCancel).toBe(true);
  });

  it("cancelled, refunded, delivered and subscription orders are not open", async () => {
    const s = await setup();
    const order = await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    await cancelOrder(order.id, { id: s.customer.id, role: "CUSTOMER" }, "x", { selfService: true });
    const sub = await placeOrder(s.customer.id, s.shopB.id, s.curd.id);
    await db.update(orders).set({ source: "SUBSCRIPTION" }).where(eq(orders.id, sub.id));
    const delivered = await placeOrder(s.customer.id, s.shopB.id, s.milk.id);
    await db.update(orders).set({ status: "DELIVERED" }).where(eq(orders.id, delivered.id));
    expect(await listOpenOrdersForCheckout(s.customer.id, [])).toHaveLength(0);
  });

  it("another customer's open orders are never listed", async () => {
    const s = await setup();
    await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    const { user: other } = await createUserWithWallet({ balancePaise: 1000 });
    expect(await listOpenOrdersForCheckout(other.id, [s.shopA.id])).toHaveLength(0);
  });

  it("scope SAME_SHOP: only open orders from a shop in the cart", async () => {
    const s = await setup();
    await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    await setRule("openOrderCheck", { enabled: true, scope: "SAME_SHOP" }, { id: s.admin.id, role: "ADMIN" });
    expect(await listOpenOrdersForCheckout(s.customer.id, [s.shopB.id])).toHaveLength(0);
    expect(await listOpenOrdersForCheckout(s.customer.id, [s.shopA.id])).toHaveLength(1);
  });

  it("rule off: nothing is listed (original behaviour)", async () => {
    const s = await setup();
    await placeOrder(s.customer.id, s.shopA.id, s.milk.id);
    await setRule("openOrderCheck", { enabled: false, scope: "ANY_SHOP" }, { id: s.admin.id, role: "ADMIN" });
    expect(await listOpenOrdersForCheckout(s.customer.id, [s.shopA.id])).toHaveLength(0);
  });
});
