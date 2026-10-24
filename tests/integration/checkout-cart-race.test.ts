/**
 * Checkout and a cart change at the same moment (found while fixing D-100).
 * Checkout read the cart, ordered each line's quantity from that read, and at
 * the end of each shop's transaction removed every line of the shop as it was
 * *then*: units added in between (a second tab, the app) were removed from the
 * cart without being ordered. Now each shop's transaction takes the cart's lock
 * first (lockCart, as an add does), reads the shop's lines again under it,
 * orders exactly those and removes exactly those — so every unit is either in
 * the order or still in the cart.
 *
 * The add is started at steps across one checkout's measured run (0 % … 110 %
 * of it), so it lands on every part of it: before the shop's transaction, in
 * it, and after it. Runs on both layouts (one database, and the seller /
 * customer split).
 */
import { and, eq, like, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { cartItems, carts, orderItems, orders, platformSettings, shopProducts, shops, wallets } from "@/server/db/schema";
import { addToCart, setCartItemQuantity } from "@/server/services/cart";
import { checkout, type CheckoutInput } from "@/server/services/orders";
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

/** resetDatabase keeps platform_settings: the online-payment rule this file turns on goes with each test. */
async function onlinePaymentsOff() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "onlinePayments"));
  clearRuleCache();
}

beforeEach(async () => {
  await resetDatabase();
  await onlinePaymentsOff();
});
afterEach(onlinePaymentsOff);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the concurrent change starts, as a share of one checkout's run. */
const STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1];

async function setup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 10_000_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "BAKERY", name: "Bread" });
  const bun = await createProduct(category.id, { name: "Burger Bun", unit: "pc" });
  const roll = await createProduct(category.id, { name: "Dinner Roll", unit: "pc" });
  const shop = await createShop(owner.id, { name: "Bakery One" });
  const bunSp = await createShopProduct(shop.id, bun.id, { onlinePricePaise: 2500, onlineStock: 5000 });
  const rollSp = await createShopProduct(shop.id, roll.id, { onlinePricePaise: 3000, onlineStock: 5000 });
  const addressId = await deliveryAddressId(customer.id);
  return { customer, owner, shop, bunSp, rollSp, addressId };
}

/** Units of one product on an order. */
async function orderedUnits(orderId: string, shopProductId: string): Promise<number> {
  const [row] = await db
    .select({ milli: sql<number>`coalesce(sum(${orderItems.quantityMilli}), 0)`.mapWith(Number) })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.shopProductId, shopProductId)));
  return row.milli / 1000;
}

/** Units of one product in the user's cart. */
async function cartUnits(userId: string, shopProductId: string): Promise<number> {
  const [row] = await db
    .select({ units: sql<number>`coalesce(sum(${cartItems.quantity}), 0)`.mapWith(Number) })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(and(eq(carts.userId, userId), eq(cartItems.shopProductId, shopProductId)));
  return row.units;
}

const ordersOf = (userId: string, requestId: string) =>
  db.select().from(orders).where(like(orders.checkoutKey, `checkout:${userId}:${requestId}:%`));

/** How long one checkout of a two-bun cart takes here (single or split layout, this machine). */
async function checkoutTime(input: Omit<CheckoutInput, "requestId">, bunId: string): Promise<number> {
  await db.delete(cartItems);
  await addToCart(input.userId, bunId, 2);
  const started = performance.now();
  await checkout({ ...input, requestId: "calibrate" });
  return performance.now() - started;
}

describe.each([
  ["paid from the wallet", "WALLET" as const],
  ["paid online (the order waits in PENDING)", "ONLINE" as const],
])("an add to cart while checkout runs, %s: every unit is in the order or still in the cart", (_case, paymentMethod) => {
  async function prepare() {
    const s = await setup();
    if (paymentMethod === "ONLINE") {
      const admin = await createUser({ role: "ADMIN" });
      await setRule("onlinePayments", { enabled: true }, admin);
    }
    const input = { userId: s.customer.id, addressId: s.addressId, paymentMethod };
    const ms = await checkoutTime(input, s.bunSp.id);
    return { ...s, input, ms };
  }

  it("the same product: the added units are ordered with the line, or stay in the cart", async () => {
    const { customer, bunSp, input, ms } = await prepare();
    const outcomes = new Set<string>();

    for (const [round, step] of STEPS.entries()) {
      await db.delete(cartItems);
      await addToCart(customer.id, bunSp.id, 2);

      const [placed] = await Promise.all([
        checkout({ ...input, requestId: `same-${round}` }),
        sleep(step * ms).then(() => addToCart(customer.id, bunSp.id, 3)),
      ]);

      expect(placed.orders).toHaveLength(1);
      const ordered = await orderedUnits(placed.orders[0].id, bunSp.id);
      const left = await cartUnits(customer.id, bunSp.id);
      // 2 + 3 units: all five ordered (the add came first), or 2 ordered and 3 left in the cart.
      expect({ step, ordered, left }).toEqual({ step, ordered, left: 5 - ordered });
      expect([2, 5]).toContain(ordered);
      outcomes.add(ordered === 5 ? "ordered" : "left in cart");
    }
    // Both orders of events happened, so the add did land on both sides of the shop's transaction.
    expect([...outcomes].sort()).toEqual(["left in cart", "ordered"]);
  });

  it("another product of the same shop: it is ordered too, or stays in the cart", async () => {
    const { customer, bunSp, rollSp, input, ms } = await prepare();

    for (const [round, step] of STEPS.entries()) {
      await db.delete(cartItems);
      await addToCart(customer.id, bunSp.id, 2);

      const [placed] = await Promise.all([
        checkout({ ...input, requestId: `other-${round}` }),
        sleep(step * ms).then(() => addToCart(customer.id, rollSp.id, 4)),
      ]);

      expect(placed.orders).toHaveLength(1);
      const orderId = placed.orders[0].id;
      expect(await orderedUnits(orderId, bunSp.id)).toBe(2);
      expect(await cartUnits(customer.id, bunSp.id)).toBe(0);
      const ordered = await orderedUnits(orderId, rollSp.id);
      expect({ step, rolls: ordered + (await cartUnits(customer.id, rollSp.id)) }).toEqual({ step, rolls: 4 });
      // The order's money matches its lines (a roll ordered is a roll paid for).
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(order.subtotalPaise).toBe(2 * 2500 + ordered * 3000);
    }
  });
});

describe("two checkouts of the same cart at the same moment", () => {
  it("from two tabs (two request ids): the cart is ordered once, the other is refused", async () => {
    const { customer, bunSp, addressId } = await setup();
    await addToCart(customer.id, bunSp.id, 2);
    const [{ balancePaise: before }] = await db.select().from(wallets).where(eq(wallets.userId, customer.id));

    const results = await Promise.allSettled([
      checkout({ userId: customer.id, addressId, requestId: "tab-1" }),
      checkout({ userId: customer.id, addressId, requestId: "tab-2" }),
    ]);

    const placed = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(placed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Nothing from Bakery One is in your cart/) });
    expect(await db.select().from(orders)).toHaveLength(1);
    const [{ balancePaise: after }] = await db.select().from(wallets).where(eq(wallets.userId, customer.id));
    expect(before - after).toBe(5000);
    const [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, bunSp.id));
    expect(sp.onlineStock).toBe(4998);
  });

  it("a double submit (the same request id): one order, and both answers carry it", async () => {
    const { customer, bunSp, addressId } = await setup();
    await addToCart(customer.id, bunSp.id, 2);

    const [a, b] = await Promise.all([
      checkout({ userId: customer.id, addressId, requestId: "double" }),
      checkout({ userId: customer.id, addressId, requestId: "double" }),
    ]);

    expect(await ordersOf(customer.id, "double")).toHaveLength(1);
    expect(a.orders.map((o) => o.id)).toEqual(b.orders.map((o) => o.id));
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
    expect(await cartUnits(customer.id, bunSp.id)).toBe(0);
  });
});

describe("a quantity lowered while checkout runs", () => {
  it("is ordered as lowered, never below the shop's minimum order", async () => {
    const { customer, shop, bunSp, addressId } = await setup();
    const input = { userId: customer.id, addressId };
    const ms = await checkoutTime(input, bunSp.id);
    // ₹60 minimum: 4 buns (₹100) pass, 1 bun (₹25) does not.
    await db.update(shops).set({ minOrderPaise: 6000 }).where(eq(shops.id, shop.id));

    for (const [round, step] of STEPS.entries()) {
      await db.delete(cartItems);
      const cart = await addToCart(customer.id, bunSp.id, 4);
      const lineId = cart.groups[0].lines[0].cartItemId;

      const [placed, lowered] = await Promise.allSettled([
        checkout({ ...input, requestId: `lower-${round}` }),
        sleep(step * ms).then(() => setCartItemQuantity(customer.id, lineId, 1)),
      ]);

      if (placed.status === "fulfilled") {
        // Ordered before the change: all 4; the change then finds the line gone.
        expect(await orderedUnits(placed.value.orders[0].id, bunSp.id)).toBe(4);
        expect(lowered).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
      } else {
        // Lowered first: the order of ₹25 is refused for the minimum, and the line keeps its 1.
        expect(placed.reason).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/minimum order/) });
        expect(lowered.status).toBe("fulfilled");
        expect(await cartUnits(customer.id, bunSp.id)).toBe(1);
      }
    }
    // No order was ever placed for less than the minimum (the ₹50 one is the calibration's, before it).
    const placedOrders = await db.select().from(orders).where(like(orders.checkoutKey, `checkout:${customer.id}:lower-%`));
    expect(placedOrders.every((o) => o.subtotalPaise >= 6000)).toBe(true);
  });
});
