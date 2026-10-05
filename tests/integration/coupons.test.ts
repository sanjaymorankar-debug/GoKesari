/**
 * F7 — order-level coupons: flat / percent off the whole order's goods, with
 * minimum value, dates, total and per-customer limits; split across shops in
 * proportion to goods value; all validated on the server.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { couponRedemptions, orderFinancials, platformSettings, wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { couponDiscount, quoteCoupon, saveCoupon, splitProportionally } from "@/server/services/coupons";
import { recordOrderFinancials } from "@/server/services/finance";
import { acceptOrder, removeItem, startPicking } from "@/server/services/fulfilment";
import { checkout } from "@/server/services/orders";
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

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "coupons"));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

const enable = () => setRule("coupons", { enabled: true }, admin);

async function twoShops() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 1_000_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const a = await createShop(owner.id, { name: "Dairy One" });
  const b = await createShop(owner.id, { name: "Dairy Two" });
  const spA = await createShopProduct(a.id, milk.id, { onlinePricePaise: 30_000, onlineStock: 50 });
  const spB = await createShopProduct(b.id, milk.id, { onlinePricePaise: 10_000, onlineStock: 50 });
  return { customer, a, b, spA, spB };
}

const balance = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const place = async (userId: string, requestId: string, couponCode?: string) =>
  checkout({ userId, addressId: await deliveryAddressId(userId), requestId, couponCode });

describe("pricing helpers", () => {
  it("computes flat and capped percent discounts, never above the goods", () => {
    expect(couponDiscount({ discountType: "FLAT", flatPaise: 5000, percent: null, maxDiscountPaise: null }, 3000)).toBe(3000);
    expect(couponDiscount({ discountType: "PERCENT", flatPaise: null, percent: 10, maxDiscountPaise: 1500 }, 40_000)).toBe(1500);
    expect(couponDiscount({ discountType: "PERCENT", flatPaise: null, percent: 15, maxDiscountPaise: null }, 999)).toBe(149);
  });

  it("splits proportionally and exactly", () => {
    expect(splitProportionally(1000, [30_000, 10_000])).toEqual([750, 250]);
    expect(splitProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitProportionally(0, [5, 5])).toEqual([0, 0]);
  });
});

describe("checkout with a coupon", () => {
  it("is refused while coupons are switched off", async () => {
    const { customer, spA } = await twoShops();
    await saveCoupon({ code: "SAVE10", discountType: "FLAT", flatPaise: 1000 }, admin);
    await addToCart(customer.id, spA.id, 1);
    await expect(place(customer.id, "c-off", "SAVE10")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("splits the discount across sub-orders by goods value and charges the net total", async () => {
    await enable();
    const { customer, a, b, spA, spB } = await twoShops();
    await saveCoupon({ code: "save100", discountType: "FLAT", flatPaise: 10_000, minOrderPaise: 20_000 }, admin);
    await addToCart(customer.id, spA.id, 1); // ₹300
    await addToCart(customer.id, spB.id, 1); // ₹100
    const before = await balance(customer.id);
    const { orders: placed } = await place(customer.id, "c-split", "SAVE100");
    const byShop = Object.fromEntries(placed.map((o) => [o.shopId, o]));
    expect(byShop[a.id].discountPaise).toBe(7500);
    expect(byShop[b.id].discountPaise).toBe(2500);
    expect(byShop[a.id].couponCode).toBe("SAVE100");
    for (const o of placed) expect(o.totalPaise).toBe(o.subtotalPaise + o.deliveryFeePaise - o.discountPaise);
    expect(before - (await balance(customer.id))).toBe(placed.reduce((n, o) => n + o.totalPaise, 0));
    expect(await db.select().from(couponRedemptions)).toHaveLength(2);

    // Platform-funded: the shop is paid on its full goods value.
    await recordOrderFinancials(byShop[a.id].id);
    const [fin] = await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, byShop[a.id].id));
    expect(fin.goodsPaise).toBe(30_000);
    expect(fin.discountPaise).toBe(7500);
  });

  it("enforces minimum order, expiry and start dates", async () => {
    await enable();
    const { customer, spB } = await twoShops();
    await saveCoupon({ code: "BIG", discountType: "FLAT", flatPaise: 1000, minOrderPaise: 50_000 }, admin);
    await saveCoupon({ code: "OLD", discountType: "FLAT", flatPaise: 1000, expiresAt: new Date(Date.now() - 1000) }, admin);
    await saveCoupon({ code: "SOON", discountType: "FLAT", flatPaise: 1000, startsAt: new Date(Date.now() + 86_400_000) }, admin);
    await addToCart(customer.id, spB.id, 1);
    for (const code of ["BIG", "OLD", "SOON", "NOPE"]) {
      await expect(place(customer.id, `c-${code}`, code)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("enforces per-customer and total usage limits, counting a multi-shop checkout once", async () => {
    await enable();
    const { customer, spA, spB } = await twoShops();
    await saveCoupon({ code: "ONCE", discountType: "PERCENT", percent: 10, perCustomerLimit: 1, usageLimit: 2 }, admin);
    await addToCart(customer.id, spA.id, 1);
    await addToCart(customer.id, spB.id, 1);
    await place(customer.id, "c-once-1", "ONCE");
    await addToCart(customer.id, spB.id, 1);
    await expect(place(customer.id, "c-once-2", "ONCE")).rejects.toMatchObject({ code: "CONFLICT" });

    const { user: other } = await createUserWithWallet({ balancePaise: 100_000 });
    await addToCart(other.id, spB.id, 1);
    await place(other.id, "c-other-1", "ONCE");
    const { user: third } = await createUserWithWallet({ balancePaise: 100_000 });
    await addToCart(third.id, spB.id, 1);
    await expect(quoteCoupon("ONCE", third.id, "q-third", [{ shopId: "x", goodsPaise: 10_000 }])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets only one of two simultaneous checkouts take the last use", async () => {
    await enable();
    const { spB } = await twoShops();
    await saveCoupon({ code: "LAST", discountType: "FLAT", flatPaise: 500, usageLimit: 1, perCustomerLimit: null }, admin);
    const { user: u1 } = await createUserWithWallet({ balancePaise: 100_000 });
    const { user: u2 } = await createUserWithWallet({ balancePaise: 100_000 });
    await addToCart(u1.id, spB.id, 1);
    await addToCart(u2.id, spB.id, 1);
    const results = await Promise.allSettled([place(u1.id, "race-1", "LAST"), place(u2.id, "race-2", "LAST")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(couponRedemptions)).toHaveLength(1);
  });

  it("never refunds more than was paid when lines of a discounted order are removed", async () => {
    await enable();
    const { customer, a, spA } = await twoShops();
    const owner = { id: a.ownerId, role: "SHOP_OWNER" as const };
    const cat = await createCategory({ department: "BAKERY", name: "Bread" });
    const bread = await createProduct(cat.id, { name: "Bread", unit: "piece" });
    const spBread = await createShopProduct(a.id, bread.id, { onlinePricePaise: 10_000, onlineStock: 50 });
    await saveCoupon({ code: "OFF150", discountType: "FLAT", flatPaise: 15_000 }, admin);
    await addToCart(customer.id, spA.id, 1); // ₹300
    await addToCart(customer.id, spBread.id, 1); // ₹100
    const start = await balance(customer.id);
    const { orders: [order] } = await place(customer.id, "c-refund", "OFF150");
    expect(order.discountPaise).toBe(15_000);
    await acceptOrder(order.id, owner);
    await startPicking(order.id, owner);
    const items = await db.query.orderItems.findMany({ where: (t, { eq: e }) => e(t.orderId, order.id) });
    const milkLine = items.find((i) => i.lineTotalPaise === 30_000)!;
    await removeItem(order.id, milkLine.id, owner, "Out of stock");
    // Goods paid were ₹250 (₹400 − ₹150): the ₹300 line refunds at most that.
    expect((await balance(customer.id)) - (start - order.totalPaise)).toBe(25_000);
    const breadLine = items.find((i) => i.lineTotalPaise === 10_000)!;
    await removeItem(order.id, breadLine.id, owner, "Out of stock");
    expect(await balance(customer.id)).toBe(start); // everything back, nothing extra
  });

  it("leaves checkout without a code unchanged", async () => {
    await enable();
    const { customer, spB } = await twoShops();
    await addToCart(customer.id, spB.id, 1);
    const { orders: placed } = await place(customer.id, "c-none");
    expect(placed[0].discountPaise).toBe(0);
    expect(placed[0].couponCode).toBeNull();
    expect(placed[0].totalPaise).toBe(placed[0].subtotalPaise + placed[0].deliveryFeePaise);
  });
});
