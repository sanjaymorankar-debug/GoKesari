/**
 * F6 — one parent reference for a multi-shop checkout. Each shop still gets
 * its own order; single-shop orders and the rule-off path are unchanged.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orderGroups, platformSettings } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { getOrderGroupForUser } from "@/server/services/order-groups";
import { checkout, listOrdersForShop } from "@/server/services/orders";
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

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "parentOrders"));
  clearRuleCache();
});

async function enable() {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("parentOrders", { enabled: true }, { id: admin.id, role: "ADMIN" });
}

async function twoShops() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const a = await createShop(owner.id, { name: "Dairy One" });
  const b = await createShop(owner.id, { name: "Dairy Two" });
  const spA = await createShopProduct(a.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const spB = await createShopProduct(b.id, milk.id, { onlinePricePaise: 6800, onlineStock: 50 });
  return { customer, a, b, spA, spB };
}

describe("parent orders", () => {
  it("is off by default: one order per shop, no parent reference", async () => {
    const { customer, spA, spB } = await twoShops();
    await addToCart(customer.id, spA.id, 1);
    await addToCart(customer.id, spB.id, 1);
    const result = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "grp-off-1" });
    expect(result.orders).toHaveLength(2);
    expect(result.parentReference).toBeUndefined();
    expect(result.orders.every((o) => o.orderGroupId === null)).toBe(true);
  });

  it("gives a multi-shop cart one reference over per-shop sub-orders", async () => {
    await enable();
    const { customer, a, b, spA, spB } = await twoShops();
    await addToCart(customer.id, spA.id, 1);
    await addToCart(customer.id, spB.id, 2);
    const result = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "grp-on-1" });
    expect(result.parentReference).toMatch(/^GK-\d{8}-[A-Z0-9]{6}$/);
    expect(result.orders).toHaveLength(2);
    expect(new Set(result.orders.map((o) => o.orderGroupId)).size).toBe(1);
    // Each sub-order keeps its own DB-… number and is visible to its own shop only.
    expect(result.orders.every((o) => o.orderNumber.startsWith("DB-"))).toBe(true);
    expect((await listOrdersForShop(a.id)).map((o) => o.shopId)).toEqual([a.id]);
    expect((await listOrdersForShop(b.id)).map((o) => o.shopId)).toEqual([b.id]);

    const group = await getOrderGroupForUser(customer.id, result.parentReference!);
    expect(group.orders).toHaveLength(2);
    expect(group.totalPaise).toBe(result.orders.reduce((n, o) => n + o.totalPaise, 0));

    // A retried request returns the same reference and creates nothing new.
    const again = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "grp-on-1" });
    expect(again.deduplicated).toBe(true);
    expect(again.parentReference).toBe(result.parentReference);
    expect(await db.select().from(orderGroups)).toHaveLength(1);
  });

  it("leaves single-shop orders without a group, and hides other customers' groups", async () => {
    await enable();
    const { customer, spA, spB } = await twoShops();
    await addToCart(customer.id, spA.id, 1);
    const single = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "grp-single" });
    expect(single.parentReference).toBeUndefined();
    expect(single.orders[0].orderGroupId).toBeNull();

    await addToCart(customer.id, spA.id, 1);
    await addToCart(customer.id, spB.id, 1);
    const multi = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "grp-multi" });
    const stranger = await createUser();
    await expect(getOrderGroupForUser(stranger.id, multi.parentReference!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
