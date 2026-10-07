/**
 * Cart quantities for product cards: a card for something already in the cart
 * must open on its in-cart controls after a reload, not on "Add to cart".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { carts } from "@/server/db/schema";
import {
  addToCart,
  getCart,
  getCartLineQuantities,
  removeCartItem,
} from "@/server/services/cart";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

async function setup() {
  const customer = await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const curd = await createProduct(category.id, { name: "Curd", unit: "kg" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const curdSp = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 9000, onlineStock: 50 });
  return { customer, milkSp, curdSp };
}

describe("getCartLineQuantities", () => {
  it("returns each cart line's id and quantity keyed by shop product", async () => {
    const { customer, milkSp, curdSp } = await setup();
    await addToCart(customer.id, milkSp.id, 2);

    const lines = await getCartLineQuantities(customer.id);
    const cartLine = (await getCart(customer.id)).groups[0].lines[0];

    expect([...lines.keys()]).toEqual([milkSp.id]);
    expect(lines.get(milkSp.id)).toEqual({ cartItemId: cartLine.cartItemId, quantity: 2 });
    expect(lines.has(curdSp.id)).toBe(false);
  });

  it("drops a line once it is removed from the cart", async () => {
    const { customer, milkSp } = await setup();
    await addToCart(customer.id, milkSp.id, 1);
    const { cartItemId } = (await getCartLineQuantities(customer.id)).get(milkSp.id)!;

    await removeCartItem(customer.id, cartItemId);

    expect((await getCartLineQuantities(customer.id)).size).toBe(0);
  });

  it("returns only the viewer's own cart", async () => {
    const { customer, milkSp } = await setup();
    const other = await createUser();
    await addToCart(customer.id, milkSp.id, 3);

    expect((await getCartLineQuantities(other.id)).size).toBe(0);
  });

  it("does not create a cart for a user who has none", async () => {
    const customer = await createUser();

    expect((await getCartLineQuantities(customer.id)).size).toBe(0);
    expect(await db.select().from(carts)).toHaveLength(0);
  });
});
