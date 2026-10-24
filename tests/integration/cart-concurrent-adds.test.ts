/**
 * TC-CART-001 / TC-LIST-021 (QA run of 24 Oct 2026, logged in PR #239): two
 * "add to cart"s of the same product at the same moment — a double tap, or two
 * tabs.
 * On an empty cart one answered 500 (the second insert hit
 * cart_items_cart_product_unique); onto an existing line both answered 200 but
 * one add was lost (1 + 2 + 2 saved as 3), as both wrote existing + quantity
 * from the same read. Every add or quantity change now runs in a transaction
 * that locks the cart row first, so simultaneous ones run one after the other.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { PATCH as patchItemRoute } from "@/app/api/cart/items/[id]/route";
import { POST as addRoute } from "@/app/api/cart/route";
import { db } from "@/server/db";
import { cartItems, carts } from "@/server/db/schema";
import { addToCart, getOrCreateCart } from "@/server/services/cart";
import { addPurchaseListItem, createPurchaseList, sendPurchaseListToCart } from "@/server/services/purchase-lists";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

async function setup(onlineStock = 500) {
  const customer = await createUser();
  state.session = {
    user: { id: customer.id, email: customer.email, name: customer.name, image: null, role: customer.role, status: "ACTIVE" },
  };
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "BAKERY", name: "Bread" });
  const bun = await createProduct(category.id, { name: "Burger Bun", unit: "pc" });
  const shop = await createShop(owner.id, { name: "Bakery One" });
  const sp = await createShopProduct(shop.id, bun.id, { onlinePricePaise: 2500, onlineStock });
  return { customer, sp };
}

const add = (shopProductId: string, quantity: number) =>
  call(addRoute, "/api/cart", { method: "POST", body: { shopProductId, quantity } });

/** The saved lines for the product: one at most, by the unique index. */
async function savedLines(userId: string, shopProductId: string) {
  return db
    .select({ id: cartItems.id, quantity: cartItems.quantity })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(and(eq(carts.userId, userId), eq(cartItems.shopProductId, shopProductId)));
}

describe("TC-CART-001: simultaneous adds of the same product", () => {
  it.each([
    ["no cart yet", false],
    ["an empty cart", true],
  ])("on %s: every add answers 200 and the line holds the sum", async (_case, cartFirst) => {
    const { customer, sp } = await setup();
    if (cartFirst) await getOrCreateCart(customer.id);

    const results = await Promise.all([add(sp.id, 2), add(sp.id, 2), add(sp.id, 3)]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await savedLines(customer.id, sp.id)).toEqual([{ id: expect.any(String), quantity: 7 }]);
  });

  it("onto an existing line: every add answers 200 and no units are lost", async () => {
    const { customer, sp } = await setup();
    await addToCart(customer.id, sp.id, 1);

    const results = await Promise.all([add(sp.id, 2), add(sp.id, 2)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await savedLines(customer.id, sp.id)).toEqual([{ id: expect.any(String), quantity: 5 }]);
    // The later answer shows the sum; the earlier one at least the first add (1 + 2).
    const answered = results.map((r) => r.body.groups[0].lines[0].quantity).sort((a, b) => a - b);
    expect(answered[1]).toBe(5);
    expect(answered[0]).toBeGreaterThanOrEqual(3);
  });

  it("stops the line at 99, as the API caps one add", async () => {
    const { customer, sp } = await setup();
    await addToCart(customer.id, sp.id, 95);

    const results = await Promise.all([add(sp.id, 3), add(sp.id, 3), add(sp.id, 3)]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await savedLines(customer.id, sp.id)).toEqual([{ id: expect.any(String), quantity: 99 }]);
  });

  it("checks stock against the sum: past the stock one add is refused with 409, never 500", async () => {
    const { customer, sp } = await setup(4);

    const results = await Promise.all([add(sp.id, 3), add(sp.id, 3)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.error).toMatchObject({ code: "OUT_OF_STOCK", message: "Only 4 left in stock." });
    expect(await savedLines(customer.id, sp.id)).toEqual([{ id: expect.any(String), quantity: 3 }]);
  });

  it("a quantity change at the same time as an add: they run one after the other", async () => {
    const { customer, sp } = await setup();
    await addToCart(customer.id, sp.id, 1);
    const [line] = await savedLines(customer.id, sp.id);

    const results = await Promise.all([
      call(patchItemRoute, `/api/cart/items/${line.id}`, { method: "PATCH", body: { quantity: 5 }, params: { id: line.id } }),
      add(sp.id, 2),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // Set to 5 then add 2 → 7; add 2 then set to 5 → 5. Never 3 (the add's stale 1 + 2 written over the 5).
    expect([5, 7]).toContain((await savedLines(customer.id, sp.id))[0].quantity);
  });

  it("a purchase list sent to the cart at the same time as an add: both land", async () => {
    const { customer, sp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: sp.id, quantity: 2 });

    // The send runs several statements before it reads the cart, so the add is started a few
    // milliseconds later in each round, to land on every step of it (unlocked, 3 or 4 were saved).
    for (const delayMs of [0, 2, 4, 6, 8, 10, 12]) {
      await db.delete(cartItems);
      await addToCart(customer.id, sp.id, 1);

      const [sent, added] = await Promise.all([
        sendPurchaseListToCart(customer.id, list.id, "ADD"),
        new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => add(sp.id, 3)),
      ]);

      expect(added.status).toBe(200);
      expect(sent.added).toEqual([expect.objectContaining({ shopProductId: sp.id, quantity: 2 })]);
      expect(await savedLines(customer.id, sp.id)).toEqual([{ id: expect.any(String), quantity: 6 }]);
    }
  });
});
