/**
 * D-102 (docs/testing/qa-defects.json): two "add to cart" of the same product
 * at the same moment — a double tap, or two tabs. On a new line one of them
 * answered 500 (the second insert hit cart_items_cart_product_unique); onto an
 * existing line both answered 200 but one add was lost (1 + 2 + 2 saved as 3).
 * Every change that reads a cart line before writing it — add, set quantity, a
 * purchase list's send — now locks the cart first, so they run one after the
 * other and each sees what the one before it wrote.
 *
 * Runs on both layouts (one database, and the seller / customer split).
 */
import { eq } from "drizzle-orm";
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
import { addToCart, clearCart, getCart, getOrCreateCart } from "@/server/services/cart";
import { addPurchaseListItem, createPurchaseList, sendPurchaseListToCart } from "@/server/services/purchase-lists";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

async function setup(onlineStock = 500) {
  const customer = await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "BAKERY", name: "Bread" });
  const bun = await createProduct(category.id, { name: "Burger Bun", unit: "pc" });
  const shop = await createShop(owner.id, { name: "Bakery One" });
  const bunSp = await createShopProduct(shop.id, bun.id, { onlinePricePaise: 2000, onlineStock });
  state.session = { user: { id: customer.id, email: customer.email, name: customer.name, image: null, role: customer.role, status: "ACTIVE" } };
  return { customer, bunSp };
}

/** POST /api/cart once per quantity, all at the same moment. */
function addAtOnce(shopProductId: string, quantities: number[]) {
  return Promise.all(quantities.map((quantity) => call(addRoute, "/api/cart", { method: "POST", body: { shopProductId, quantity } })));
}

async function lines(userId: string) {
  return (await getCart(userId)).groups.flatMap((g) => g.lines);
}

describe("D-102: adds of the same product at the same moment", () => {
  it("on a customer with no cart yet: every add answers 200 and the one line holds the sum", async () => {
    const { customer, bunSp } = await setup();

    const answers = await addAtOnce(bunSp.id, [2, 3]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([5]);
    expect(await db.select().from(carts).where(eq(carts.userId, customer.id))).toHaveLength(1);
    // The saved quantity is what the answers report: the later of the two shows the whole sum.
    expect(Math.max(...answers.map((a) => a.body.itemCount))).toBe(5);
  });

  it("on an emptied cart: every add answers 200 and the one line holds the sum", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 1);
    await clearCart(customer.id);

    const answers = await addAtOnce(bunSp.id, [2, 2]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([4]);
  });

  it("onto an existing line: no add is lost (1 + 2 + 2 = 5)", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 1);

    const answers = await addAtOnce(bunSp.id, [2, 2]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([5]);
    expect(Math.max(...answers.map((a) => a.body.itemCount))).toBe(5);
  });

  it("five at once onto an existing line: all five land", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 1);

    const answers = await addAtOnce(bunSp.id, [1, 1, 1, 1, 1]);

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([6]);
  });

  it("caps the sum at 99, the most one cart line holds — both adds still answer 200", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 60);

    const answers = await addAtOnce(bunSp.id, [30, 30]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([99]);
  });

  it("checks stock against the sum: the add that would pass the stock is refused, the other goes in", async () => {
    const { customer, bunSp } = await setup(4);

    const answers = await addAtOnce(bunSp.id, [3, 3]);

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)?.body.error.message).toMatch(/Only 4 left/);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([3]);
  });
});

describe("the 99 cap on one cart line", () => {
  it("refuses an add onto a full line with a clear message and leaves it as it is", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 99);

    const [answer] = await addAtOnce(bunSp.id, [1]);

    expect(answer.status).toBe(422);
    expect(answer.body.error.message).toMatch(/already has 99/);
    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([99]);
  });

  it("refuses more than 99 in one add, as the API does", async () => {
    const { customer, bunSp } = await setup();
    await expect(addToCart(customer.id, bunSp.id, 100)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await lines(customer.id)).toEqual([]);
  });
});

describe("set quantity and a purchase list's send wait for the same lock", () => {
  it("a quantity set at the same moment as an add: one runs after the other, never a mix of the two", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 1);
    const [line] = await db.select().from(cartItems);

    for (let round = 0; round < 5; round++) {
      await db.update(cartItems).set({ quantity: 1 }).where(eq(cartItems.id, line.id));
      const [set, add] = await Promise.all([
        call(patchItemRoute, `/api/cart/items/${line.id}`, { method: "PATCH", body: { quantity: 4 }, params: { id: line.id } }),
        call(addRoute, "/api/cart", { method: "POST", body: { shopProductId: bunSp.id, quantity: 2 } }),
      ]);

      expect([set.status, add.status]).toEqual([200, 200]);
      // Set then add → 6; add then set → 4. The add writing from its read before the set (the old bug) → 3.
      expect([4, 6]).toContain((await lines(customer.id))[0].quantity);
    }
  });

  it("a purchase list sent while the same product is added: both land", async () => {
    const { customer, bunSp } = await setup();
    await addToCart(customer.id, bunSp.id, 1);
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: bunSp.id, quantity: 2 });

    for (let round = 0; round < 5; round++) {
      await db.update(cartItems).set({ quantity: 1 });
      const [sent, [added]] = await Promise.all([sendPurchaseListToCart(customer.id, list.id, "ADD"), addAtOnce(bunSp.id, [2])]);

      expect(sent.added.map((a) => a.quantity)).toEqual([2]);
      expect(added.status).toBe(200);
      expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([5]);
    }
  });

  it("two lists with the same product sent at the same moment onto an empty cart: both land on one line", async () => {
    const { customer, bunSp } = await setup();
    // The cart exists but is empty: creating it would make the second send wait on its own.
    await getOrCreateCart(customer.id);
    const weekly = await createPurchaseList(customer.id, { name: "Weekly" });
    const monthly = await createPurchaseList(customer.id, { name: "Monthly" });
    await addPurchaseListItem(customer.id, weekly.id, { shopProductId: bunSp.id, quantity: 2 });
    await addPurchaseListItem(customer.id, monthly.id, { shopProductId: bunSp.id, quantity: 3 });

    await Promise.all([sendPurchaseListToCart(customer.id, weekly.id, "ADD"), sendPurchaseListToCart(customer.id, monthly.id, "ADD")]);

    expect((await lines(customer.id)).map((l) => l.quantity)).toEqual([5]);
  });
});
