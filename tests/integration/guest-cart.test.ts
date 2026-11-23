/**
 * docs/guest-cart-2026-11: pricing a guest's browser cart (nothing saved) and
 * moving it into the account cart after sign-in (owner rule: add quantities,
 * capped at stock and the line maximum; unavailable lines dropped and named).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { cartItems, carts, shopProducts } from "@/server/db/schema";
import { addToCart, getCart } from "@/server/services/cart";
import { mergeGuestCart, previewGuestCart } from "@/server/services/guest-cart";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);

const NO_SUCH = "00000000-0000-4000-8000-000000000000";

async function setup() {
  const customer = await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const curd = await createProduct(category.id, { name: "Curd", unit: "kg" });
  const ghee = await createProduct(category.id, { name: "Ghee", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const curdSp = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 9000, onlineStock: 3 });
  const gheeSp = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 60000, onlineStock: 10, isAvailable: false });
  return { customer, milkSp, curdSp, gheeSp };
}

describe("previewGuestCart", () => {
  it("prices lines like a cart without creating any cart", async () => {
    const { milkSp, curdSp } = await setup();
    const preview = await previewGuestCart([
      { shopProductId: milkSp.id, quantity: 2 },
      { shopProductId: curdSp.id, quantity: 1 },
      { shopProductId: NO_SUCH, quantity: 1 },
    ]);
    expect(preview.groups).toHaveLength(1);
    expect(preview.subtotalPaise).toBe(2 * 7000 + 9000);
    expect(preview.groups[0].lines.map((l) => l.cartItemId).sort()).toEqual([milkSp.id, curdSp.id].sort());
    expect(preview.missingShopProductIds).toEqual([NO_SUCH]);
    expect(await db.select().from(carts)).toHaveLength(0);
  });

  it("flags an item that cannot be bought now and leaves it out of the total", async () => {
    const { gheeSp } = await setup();
    const preview = await previewGuestCart([{ shopProductId: gheeSp.id, quantity: 1 }]);
    expect(preview.hasUnavailableItems).toBe(true);
    expect(preview.subtotalPaise).toBe(0);
  });
});

describe("mergeGuestCart", () => {
  it("moves the guest lines into an empty account cart", async () => {
    const { customer, milkSp, curdSp } = await setup();
    const result = await mergeGuestCart(customer.id, [
      { shopProductId: milkSp.id, quantity: 2 },
      { shopProductId: curdSp.id, quantity: 1 },
    ]);
    expect(result).toEqual({ added: 2, reduced: [], dropped: [] });
    const cart = await getCart(customer.id);
    expect(Object.fromEntries(cart.groups[0].lines.map((l) => [l.shopProductId, l.quantity]))).toEqual({ [milkSp.id]: 2, [curdSp.id]: 1 });
  });

  it("adds to what the account cart already holds", async () => {
    const { customer, milkSp } = await setup();
    await addToCart(customer.id, milkSp.id, 3);
    await mergeGuestCart(customer.id, [{ shopProductId: milkSp.id, quantity: 2 }]);
    const [line] = await db.select({ quantity: cartItems.quantity }).from(cartItems);
    expect(line.quantity).toBe(5);
  });

  it("caps at the stock and says so", async () => {
    const { customer, curdSp } = await setup();
    await addToCart(customer.id, curdSp.id, 1);
    const result = await mergeGuestCart(customer.id, [{ shopProductId: curdSp.id, quantity: 5 }]);
    expect(result.reduced).toEqual([{ shopProductId: curdSp.id, productName: "Curd", quantity: 2 }]);
    const [line] = await db.select({ quantity: cartItems.quantity }).from(cartItems);
    expect(line.quantity).toBe(3);
  });

  it("drops a listing that cannot be bought or no longer exists, and keeps the rest", async () => {
    const { customer, milkSp, gheeSp } = await setup();
    const result = await mergeGuestCart(customer.id, [
      { shopProductId: gheeSp.id, quantity: 1 },
      { shopProductId: NO_SUCH, quantity: 1 },
      { shopProductId: milkSp.id, quantity: 1 },
    ]);
    expect(result.added).toBe(1);
    expect(result.dropped.map((d) => d.shopProductId).sort()).toEqual([gheeSp.id, NO_SUCH].sort());
    expect(result.dropped.find((d) => d.shopProductId === gheeSp.id)?.productName).toBe("Ghee");
    expect(await db.select().from(cartItems)).toHaveLength(1);
  });

  it("drops an out-of-stock line", async () => {
    const { customer, curdSp } = await setup();
    await db.update(shopProducts).set({ onlineStock: 0 }).where(eq(shopProducts.id, curdSp.id));
    const result = await mergeGuestCart(customer.id, [{ shopProductId: curdSp.id, quantity: 1 }]);
    expect(result.dropped).toEqual([{ shopProductId: curdSp.id, productName: "Curd", reason: "Out of stock." }]);
  });

  it("does nothing for an empty guest cart", async () => {
    const { customer } = await setup();
    expect(await mergeGuestCart(customer.id, [])).toEqual({ added: 0, reduced: [], dropped: [] });
  });
});
