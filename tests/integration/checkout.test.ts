/**
 * Wallet checkout (requirements §17, §22, §23, §48).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  orderItems,
  orders,
  shopProducts,
  walletTransactions,
  wallets,
} from "@/server/db/schema";
import { addToCart, getCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
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

beforeEach(resetDatabase);

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!
    .balancePaise;

/** Two approved shops, one product each: milk at ₹70 and bread at ₹45. */
async function twoShopSetup(balancePaise: number) {
  const { user: customer } = await createUserWithWallet({ balancePaise });
  const owner = await createUser({ role: "SHOP_OWNER" });

  const dairyCat = await createCategory({ department: "DAIRY", name: "Milk" });
  const bakeryCat = await createCategory({ department: "BAKERY", name: "Bread" });
  const milk = await createProduct(dairyCat.id, { name: "Cow Milk", unit: "L" });
  const bread = await createProduct(bakeryCat.id, {
    name: "White Bread",
    unit: "piece",
  });

  const dairy = await createShop(owner.id, { name: "Dairy One" });
  const bakery = await createShop(owner.id, { name: "Bakery Two" });

  const milkSp = await createShopProduct(dairy.id, milk.id, {
    onlinePricePaise: 7000,
    onlineStock: 50,
  });
  const breadSp = await createShopProduct(bakery.id, bread.id, {
    onlinePricePaise: 4500,
    onlineStock: 50,
  });

  return { customer, dairy, bakery, milkSp, breadSp };
}

describe("multi-shop checkout (§17)", () => {
  it("splits a cross-shop cart into one order per shop", async () => {
    const { customer, dairy, bakery, milkSp, breadSp } =
      await twoShopSetup(500_000);

    await addToCart(customer.id, milkSp.id, 2); // 2 × ₹70 = ₹140
    await addToCart(customer.id, breadSp.id, 1); // 1 × ₹45 = ₹45

    const result = await checkout({
      userId: customer.id,
      addressId: await deliveryAddressId(customer.id),
      requestId: "req-split-001",
    });

    expect(result.orders).toHaveLength(2);
    const shopIds = result.orders.map((o) => o.shopId).sort();
    expect(shopIds).toEqual([dairy.id, bakery.id].sort());

    // Each shop's delivery fee applies independently (₹20 each here).
    const total = result.orders.reduce((n, o) => n + o.totalPaise, 0);
    expect(await balanceOf(customer.id)).toBe(500_000 - total);

    for (const order of result.orders) {
      expect(order.status).toBe("CONFIRMED");
      expect(order.paidAt).not.toBeNull();
    }
  });

  it("empties the cart once every shop has been checked out", async () => {
    const { customer, milkSp, breadSp } = await twoShopSetup(500_000);
    await addToCart(customer.id, milkSp.id, 1);
    await addToCart(customer.id, breadSp.id, 1);

    await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "req-empty-001" });

    const cart = await getCart(customer.id);
    expect(cart.groups).toHaveLength(0);
    expect(cart.itemCount).toBe(0);
  });

  it("snapshots the price and product name onto the order line", async () => {
    const { customer, milkSp } = await twoShopSetup(500_000);
    await addToCart(customer.id, milkSp.id, 2);

    const { orders: placed } = await checkout({
      userId: customer.id,
      addressId: await deliveryAddressId(customer.id),
      requestId: "req-snap-001",
    });

    const [item] = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed[0].id));

    expect(item.productNameSnapshot).toBe("Cow Milk");
    expect(item.unitPricePaise).toBe(7000);
    expect(item.quantityMilli).toBe(2000); // 2 × 1 L
    expect(item.lineTotalPaise).toBe(14_000);

    // A later price change must not alter the placed order.
    await db
      .update(shopProducts)
      .set({ onlinePricePaise: 9900 })
      .where(eq(shopProducts.id, milkSp.id));

    const [after] = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed[0].id));
    expect(after.unitPricePaise).toBe(7000);
  });

  it("decrements stock by the ordered quantity", async () => {
    const { customer, milkSp } = await twoShopSetup(500_000);
    await addToCart(customer.id, milkSp.id, 3);

    await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "req-stock-001" });

    const after = await db.query.shopProducts.findFirst({
      where: eq(shopProducts.id, milkSp.id),
    });
    expect(after?.onlineStock).toBe(47);
  });
});

describe("insufficient balance (§23)", () => {
  it("creates no order and takes no money", async () => {
    // ₹50 balance against a ₹140 + ₹20 delivery order.
    const { customer, milkSp } = await twoShopSetup(5_000);
    await addToCart(customer.id, milkSp.id, 2);

    await expect(
      checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "req-poor-001" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    expect(await balanceOf(customer.id)).toBe(5_000);
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(walletTransactions)).toHaveLength(0);

    // Stock must not have been consumed by the rolled-back attempt.
    const sp = await db.query.shopProducts.findFirst({
      where: eq(shopProducts.id, milkSp.id),
    });
    expect(sp?.onlineStock).toBe(50);

    // The cart is preserved so the customer can top up and retry.
    const cart = await getCart(customer.id);
    expect(cart.itemCount).toBe(2);
  });
});

describe("idempotency (§48)", () => {
  it("re-submitting the same request id does not charge twice", async () => {
    const { customer, milkSp } = await twoShopSetup(500_000);
    await addToCart(customer.id, milkSp.id, 2);

    const first = await checkout({
      userId: customer.id,
      addressId: await deliveryAddressId(customer.id),
      requestId: "req-dup-001",
    });
    const balanceAfterFirst = await balanceOf(customer.id);

    const second = await checkout({
      userId: customer.id,
      addressId: await deliveryAddressId(customer.id),
      requestId: "req-dup-001",
    });

    expect(second.deduplicated).toBe(true);
    expect(second.orders[0].id).toBe(first.orders[0].id);
    expect(await balanceOf(customer.id)).toBe(balanceAfterFirst);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("rejects an empty cart", async () => {
    const { customer } = await twoShopSetup(500_000);
    await expect(
      checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "req-empty-cart" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
