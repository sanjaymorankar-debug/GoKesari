/**
 * Route-level tests for the purchase-list API (docs/purchase-lists-2026-10):
 * src/app/api/purchase-lists/**. The service is covered by
 * tests/integration/purchase-lists.test.ts; this file covers what the HTTP
 * layer adds on top — sign-in, body validation (422), ownership (404 for
 * another customer's list or item, and for a malformed id), status codes, and
 * the whole create → add → edit → check → order → cart round trip as the
 * pages drive it.
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

import { GET as checkRoute } from "@/app/api/purchase-lists/[id]/check/route";
import { DELETE as deleteItemRoute, PATCH as patchItemRoute } from "@/app/api/purchase-lists/[id]/items/[itemId]/route";
import { POST as addItemRoute } from "@/app/api/purchase-lists/[id]/items/route";
import { POST as orderRoute } from "@/app/api/purchase-lists/[id]/order/route";
import { DELETE as deleteListRoute, GET as getListRoute, PATCH as patchListRoute } from "@/app/api/purchase-lists/[id]/route";
import { POST as fromCartRoute } from "@/app/api/purchase-lists/from-cart/route";
import { GET as listsRoute, POST as createListRoute } from "@/app/api/purchase-lists/route";
import { db } from "@/server/db";
import { purchaseListItems, purchaseLists, shops } from "@/server/db/schema";
import { addToCart, getCart } from "@/server/services/cart";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

type Customer = { id: string; email: string; name: string | null; role: UserRole };

function signInAs(user: Customer, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status } };
}

const MALFORMED_ID = "not-a-uuid";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

async function setup() {
  const customer = await createUser();
  const other = await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const dairy = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(dairy.id, { name: "Cow Milk", unit: "L" });
  const curd = await createProduct(dairy.id, { name: "Curd", unit: "kg" });
  const paneer = await createProduct(dairy.id, { name: "Paneer", unit: "kg" });
  // Delivery ₹20 below ₹200, free from ₹200.
  const shop = await createShop(owner.id, { name: "Dairy One", deliveryFeePaise: 2000, freeDeliveryAbovePaise: 20000 });
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const curdSp = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 9000, onlineStock: 2 });
  const paneerSp = await createShopProduct(shop.id, paneer.id, { onlinePricePaise: 4000, onlineStock: 30 });
  return { customer, other, owner, shop, milkSp, curdSp, paneerSp };
}

/** Creates a list through the route and returns its id. */
async function createList(body: Record<string, unknown>): Promise<string> {
  const r = await call(createListRoute, "/api/purchase-lists", { method: "POST", body });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function addItem(listId: string, body: Record<string, unknown>) {
  return call(addItemRoute, `/api/purchase-lists/${listId}/items`, { method: "POST", body, params: { id: listId } });
}

async function cartLines(userId: string) {
  const cart = await getCart(userId);
  return cart.groups
    .flatMap((g) => g.lines)
    .map((l) => [l.productName, l.quantity] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/* ------------------------------------------------------------------ auth */

describe("signed out", () => {
  const ID = UNKNOWN_ID;
  const cases: [string, () => ReturnType<typeof call>][] = [
    ["GET /api/purchase-lists", () => call(listsRoute, "/api/purchase-lists")],
    ["POST /api/purchase-lists", () => call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "Weekly" } })],
    ["GET /api/purchase-lists/:id", () => call(getListRoute, `/api/purchase-lists/${ID}`, { params: { id: ID } })],
    ["PATCH /api/purchase-lists/:id", () => call(patchListRoute, `/api/purchase-lists/${ID}`, { method: "PATCH", body: { name: "x" }, params: { id: ID } })],
    ["DELETE /api/purchase-lists/:id", () => call(deleteListRoute, `/api/purchase-lists/${ID}`, { method: "DELETE", params: { id: ID } })],
    ["POST /api/purchase-lists/:id/items", () => call(addItemRoute, `/api/purchase-lists/${ID}/items`, { method: "POST", body: { shopProductId: ID }, params: { id: ID } })],
    ["PATCH /api/purchase-lists/:id/items/:itemId", () => call(patchItemRoute, `/api/purchase-lists/${ID}/items/${ID}`, { method: "PATCH", body: { quantity: 1 }, params: { id: ID, itemId: ID } })],
    ["DELETE /api/purchase-lists/:id/items/:itemId", () => call(deleteItemRoute, `/api/purchase-lists/${ID}/items/${ID}`, { method: "DELETE", params: { id: ID, itemId: ID } })],
    ["GET /api/purchase-lists/:id/check", () => call(checkRoute, `/api/purchase-lists/${ID}/check`, { params: { id: ID } })],
    ["POST /api/purchase-lists/:id/order", () => call(orderRoute, `/api/purchase-lists/${ID}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: ID } })],
    ["POST /api/purchase-lists/from-cart", () => call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { name: "From cart" } })],
  ];

  it.each(cases)("%s answers 401", async (_name, run) => {
    const r = await run();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("a suspended account's session is treated as signed out (401) and nothing is written", async () => {
    const { customer } = await setup();
    signInAs(customer, "SUSPENDED");
    const r = await call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "Weekly" } });
    expect(r.status).toBe(401);
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ lists */

describe("POST / GET /api/purchase-lists", () => {
  it("creates a list with the defaults (shopping, monthly, reminder on) and lists only the caller's lists", async () => {
    const { customer, other } = await setup();
    signInAs(other);
    await createList({ name: "Someone else's" });

    signInAs(customer);
    const created = await call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "  Monthly   groceries " } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Monthly groceries", kind: "SHOPPING", frequency: "MONTHLY", remind: true, itemCount: 0, activeItemCount: 0, lastOrderedAt: null });
    await createList({ name: "Papa's BP tablets", kind: "MEDICINE", frequency: "WEEKLY", remind: false });

    const r = await call(listsRoute, "/api/purchase-lists");
    expect(r.status).toBe(200);
    expect(r.body.lists.map((l: { name: string; kind: string; frequency: string; remind: boolean }) => [l.name, l.kind, l.frequency, l.remind])).toEqual([
      ["Monthly groceries", "SHOPPING", "MONTHLY", true],
      ["Papa's BP tablets", "MEDICINE", "WEEKLY", false],
    ]);
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a blank name", { name: "    " }],
    ["a name over 60 characters", { name: "x".repeat(61) }],
    ["a missing name", { kind: "SHOPPING" }],
    ["an unknown kind", { name: "Weekly", kind: "FOOD" }],
    ["an unknown frequency", { name: "Weekly", frequency: "DAILY" }],
    ["a non-boolean reminder", { name: "Weekly", remind: "yes" }],
    ["a name that is not a string", { name: 42 }],
  ])("refuses %s with 422", async (_what, body) => {
    const { customer } = await setup();
    signInAs(customer);
    const r = await call(createListRoute, "/api/purchase-lists", { method: "POST", body });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
  });

  it("refuses a body that is not JSON with 422", async () => {
    const { customer } = await setup();
    signInAs(customer);
    const { NextRequest } = await import("next/server");
    const response = await createListRoute(
      new NextRequest("http://localhost/api/purchase-lists", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }),
    );
    expect(response.status).toBe(422);
  });

  it("refuses a second list with the same name in any case (409), accepts exactly 60 characters", async () => {
    const { customer } = await setup();
    signInAs(customer);
    await createList({ name: "Weekly dairy" });
    const dup = await call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "WEEKLY  DAIRY" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CONFLICT");

    const longest = await call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "y".repeat(60) } });
    expect(longest.status).toBe(201);
  });

  it("allows 20 lists per customer and refuses the 21st with 409", async () => {
    const { customer } = await setup();
    signInAs(customer);
    for (let i = 1; i <= 20; i += 1) await createList({ name: `List ${i}` });
    const r = await call(createListRoute, "/api/purchase-lists", { method: "POST", body: { name: "List 21" } });
    expect(r.status).toBe(409);
    expect(await db.select().from(purchaseLists)).toHaveLength(20);
  });
});

describe("GET / PATCH / DELETE /api/purchase-lists/:id", () => {
  it("reads a list with its items at today's prices", async () => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    expect((await addItem(listId, { shopProductId: milkSp.id, quantity: 2, note: "Full cream" })).status).toBe(201);

    const r = await call(getListRoute, `/api/purchase-lists/${listId}`, { params: { id: listId } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: listId, name: "Weekly", itemCount: 1, activeItemCount: 1, estimatedSubtotalPaise: 14000 });
    expect(r.body.items[0]).toMatchObject({ productName: "Cow Milk", quantity: 2, note: "Full cream", unitPricePaise: 7000, purchasable: true, exists: true });
    expect(r.body.items[0].shop).toMatchObject({ name: "Dairy One" });
  });

  it("answers 404 for another customer's list, an unknown id and a malformed id — and changes nothing", async () => {
    const { customer, other } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Mine" });

    signInAs(other);
    for (const id of [listId, UNKNOWN_ID, MALFORMED_ID]) {
      const read = await call(getListRoute, `/api/purchase-lists/${id}`, { params: { id } });
      expect(read.status, `GET ${id}`).toBe(404);
      const patch = await call(patchListRoute, `/api/purchase-lists/${id}`, { method: "PATCH", body: { name: "Stolen" }, params: { id } });
      expect(patch.status, `PATCH ${id}`).toBe(404);
      const del = await call(deleteListRoute, `/api/purchase-lists/${id}`, { method: "DELETE", params: { id } });
      expect(del.status, `DELETE ${id}`).toBe(404);
    }
    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, listId));
    expect(row.name).toBe("Mine");
  });

  it("changes name, kind, frequency and reminder; refuses bad values (422) and a name already used (409)", async () => {
    const { customer } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Groceries" });
    await createList({ name: "Medicines", kind: "MEDICINE" });
    const patch = (body: unknown) => call(patchListRoute, `/api/purchase-lists/${listId}`, { method: "PATCH", body, params: { id: listId } });

    const ok = await patch({ name: "Monthly kirana", kind: "MEDICINE", frequency: "WEEKLY", remind: false });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Monthly kirana", kind: "MEDICINE", frequency: "WEEKLY", remind: false });

    // Same name in another case on the same list is not a clash with itself.
    expect((await patch({ name: "MONTHLY KIRANA" })).status).toBe(200);

    for (const bad of [{ name: "" }, { name: "   " }, { name: "z".repeat(61) }, { kind: "OTHER" }, { frequency: "YEARLY" }, { remind: "no" }]) {
      const r = await patch(bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    const dup = await patch({ name: "medicines" });
    expect(dup.status).toBe(409);

    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, listId));
    expect(row).toMatchObject({ name: "MONTHLY KIRANA", kind: "MEDICINE", frequency: "WEEKLY", remind: false });
  });

  it("deletes a list with its items (204), after which it is gone (404)", async () => {
    const { customer, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    await addItem(listId, { shopProductId: milkSp.id });
    await addItem(listId, { shopProductId: curdSp.id });

    const del = await call(deleteListRoute, `/api/purchase-lists/${listId}`, { method: "DELETE", params: { id: listId } });
    expect(del.status).toBe(204);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
    expect((await call(getListRoute, `/api/purchase-lists/${listId}`, { params: { id: listId } })).status).toBe(404);
    expect((await call(deleteListRoute, `/api/purchase-lists/${listId}`, { method: "DELETE", params: { id: listId } })).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ items */

describe("POST /api/purchase-lists/:id/items", () => {
  it("adds a product (201) and answers 200 alreadyOnList for the same product, leaving it as it was", async () => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });

    const first = await addItem(listId, { shopProductId: milkSp.id, quantity: 3, note: "1 after breakfast" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ alreadyOnList: false, item: { productName: "Cow Milk", quantity: 3, note: "1 after breakfast" } });

    const again = await addItem(listId, { shopProductId: milkSp.id, quantity: 9, note: "changed" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyOnList: true, item: { quantity: 3, note: "1 after breakfast" } });
    expect(await db.select().from(purchaseListItems)).toHaveLength(1);
  });

  it("defaults the quantity to 1 and accepts 0 (skip) and 99", async () => {
    const { customer, milkSp, curdSp, paneerSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    expect((await addItem(listId, { shopProductId: milkSp.id })).body.item.quantity).toBe(1);
    expect((await addItem(listId, { shopProductId: curdSp.id, quantity: 0 })).body.item.quantity).toBe(0);
    expect((await addItem(listId, { shopProductId: paneerSp.id, quantity: 99 })).body.item.quantity).toBe(99);
  });

  it.each([
    ["quantity 100", { quantity: 100 }],
    ["a negative quantity", { quantity: -1 }],
    ["a fractional quantity", { quantity: 1.5 }],
    ["a quantity as text", { quantity: "2" }],
    ["a note over 120 characters", { note: "n".repeat(121) }],
    ["a very long note", { note: "n".repeat(500) }],
  ])("refuses %s with 422", async (_what, extra) => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    const r = await addItem(listId, { shopProductId: milkSp.id, ...extra });
    expect(r.status).toBe(422);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });

  it("refuses a missing or malformed product id (422), an unknown product and a deleted shop's product (404)", async () => {
    const { customer, milkSp, shop } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    expect((await addItem(listId, {})).status).toBe(422);
    expect((await addItem(listId, { shopProductId: "abc" })).status).toBe(422);
    expect((await addItem(listId, { shopProductId: UNKNOWN_ID })).status).toBe(404);

    await db.update(shops).set({ deletedAt: new Date() }).where(eq(shops.id, shop.id));
    expect((await addItem(listId, { shopProductId: milkSp.id })).status).toBe(404);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });

  it("answers 404 when adding to another customer's list or a malformed list id", async () => {
    const { customer, other, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Mine" });
    signInAs(other);
    expect((await addItem(listId, { shopProductId: milkSp.id })).status).toBe(404);
    expect((await addItem(MALFORMED_ID, { shopProductId: milkSp.id })).status).toBe(404);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });
});

describe("PATCH / DELETE /api/purchase-lists/:id/items/:itemId", () => {
  async function listWithMilk() {
    const s = await setup();
    signInAs(s.customer);
    const listId = await createList({ name: "Weekly" });
    const itemId = (await addItem(listId, { shopProductId: s.milkSp.id, quantity: 2 })).body.item.itemId as string;
    const patch = (body: unknown, ids: { id?: string; itemId?: string } = {}) => {
      const id = ids.id ?? listId;
      const item = ids.itemId ?? itemId;
      return call(patchItemRoute, `/api/purchase-lists/${id}/items/${item}`, { method: "PATCH", body, params: { id, itemId: item } });
    };
    return { ...s, listId, itemId, patch };
  }

  it("changes the quantity (0 = skip) and the note; a blank note is cleared", async () => {
    const { patch, listId } = await listWithMilk();
    const q = await patch({ quantity: 5 });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ quantity: 5, lineTotalPaise: 35000 });

    const note = await patch({ note: "  Amul, 1 L packs  " });
    expect(note.body).toMatchObject({ quantity: 5, note: "Amul, 1 L packs" });

    const skip = await patch({ quantity: 0, note: "   " });
    expect(skip.status).toBe(200);
    expect(skip.body).toMatchObject({ quantity: 0, note: null, lineTotalPaise: 0, purchasable: true });

    const detail = await call(getListRoute, `/api/purchase-lists/${listId}`, { params: { id: listId } });
    expect(detail.body).toMatchObject({ itemCount: 1, activeItemCount: 0, estimatedSubtotalPaise: 0 });
  });

  it.each([
    ["quantity 100", { quantity: 100 }],
    ["quantity -1", { quantity: -1 }],
    ["a fractional quantity", { quantity: 2.5 }],
    ["a null quantity", { quantity: null }],
    ["a note over 120 characters", { note: "n".repeat(121) }],
  ])("refuses %s with 422 and keeps the item as it was", async (_what, body) => {
    const { patch } = await listWithMilk();
    const r = await patch(body);
    expect(r.status).toBe(422);
    const [row] = await db.select().from(purchaseListItems);
    expect(row.quantity).toBe(2);
  });

  it("answers 404 for another customer's item — through their own list or through the owner's list — and for malformed ids", async () => {
    const { other, itemId, listId, patch } = await listWithMilk();
    signInAs(other);
    const otherList = await createList({ name: "Theirs" });

    expect((await patch({ quantity: 9 }, { id: otherList })).status).toBe(404);
    expect((await patch({ quantity: 9 })).status).toBe(404);
    expect((await patch({ quantity: 9 }, { itemId: MALFORMED_ID })).status).toBe(404);
    expect((await patch({ quantity: 9 }, { id: MALFORMED_ID })).status).toBe(404);
    for (const id of [otherList, listId]) {
      const del = await call(deleteItemRoute, `/api/purchase-lists/${id}/items/${itemId}`, { method: "DELETE", params: { id, itemId } });
      expect(del.status).toBe(404);
    }
    const [row] = await db.select().from(purchaseListItems);
    expect(row.quantity).toBe(2);
  });

  it("removes an item (204); removing it again is 404", async () => {
    const { listId, itemId } = await listWithMilk();
    const del = () => call(deleteItemRoute, `/api/purchase-lists/${listId}/items/${itemId}`, { method: "DELETE", params: { id: listId, itemId } });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });
});

/* ------------------------------------------------------- check and order */

describe("check and order", () => {
  it("create → add → edit → check → order (ADD) → cart, then order (REPLACE)", async () => {
    const { customer, milkSp, curdSp, paneerSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly dairy", frequency: "WEEKLY" });
    const milkItem = (await addItem(listId, { shopProductId: milkSp.id })).body.item.itemId as string;
    const curdItem = (await addItem(listId, { shopProductId: curdSp.id, quantity: 1 })).body.item.itemId as string;
    await addItem(listId, { shopProductId: paneerSp.id, quantity: 1 });

    // Milk 1 → 2 with a note; curd skipped this time.
    const patchItem = (itemId: string, body: unknown) =>
      call(patchItemRoute, `/api/purchase-lists/${listId}/items/${itemId}`, { method: "PATCH", body, params: { id: listId, itemId } });
    expect((await patchItem(milkItem, { quantity: 2, note: "Toned" })).status).toBe(200);
    expect((await patchItem(curdItem, { quantity: 0 })).status).toBe(200);

    // Something already in the cart: the check says so.
    await addToCart(customer.id, curdSp.id, 1);
    const check = await call(checkRoute, `/api/purchase-lists/${listId}/check`, { params: { id: listId } });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ listId, listName: "Weekly dairy", cartItemCount: 1, missing: [] });
    expect(check.body.skipped.map((s: { productName: string }) => s.productName)).toEqual(["Curd"]);
    // 2 × ₹70 + 1 × ₹40 = ₹180, below ₹200: ₹20 delivery.
    expect(check.body.preview).toMatchObject({ itemCount: 3, subtotalPaise: 18000, deliveryFeePaise: 2000, grandTotalPaise: 20000, hasUnavailableItems: false });
    expect(check.body.preview.groups).toHaveLength(1);
    // The check writes nothing.
    expect(await cartLines(customer.id)).toEqual([["Curd", 1]]);

    const order = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: listId } });
    expect(order.status).toBe(200);
    expect(order.body.notAdded).toEqual([]);
    expect(order.body.added.map((a: { productName: string; quantity: number }) => [a.productName, a.quantity]).sort()).toEqual([["Cow Milk", 2], ["Paneer", 1]]);
    expect(order.body.cartItemCount).toBe(4);
    expect(await cartLines(customer.id)).toEqual([["Cow Milk", 2], ["Curd", 1], ["Paneer", 1]]);

    const after = await call(getListRoute, `/api/purchase-lists/${listId}`, { params: { id: listId } });
    expect(after.body.lastOrderedAt).not.toBeNull();
    expect(new Date(after.body.nextDueAt).getTime() - new Date(after.body.lastOrderedAt).getTime()).toBe(7 * 24 * 3600 * 1000);
    // The list itself is unchanged by ordering.
    expect(after.body.items.map((i: { productName: string; quantity: number }) => [i.productName, i.quantity])).toEqual([["Cow Milk", 2], ["Curd", 0], ["Paneer", 1]]);

    const replace = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "REPLACE" }, params: { id: listId } });
    expect(replace.status).toBe(200);
    expect(replace.body.cartItemCount).toBe(3);
    expect(await cartLines(customer.id)).toEqual([["Cow Milk", 2], ["Paneer", 1]]);
  });

  it("the check's total is the cart's total once the list is in an empty cart", async () => {
    const { customer, milkSp, paneerSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Monthly" });
    await addItem(listId, { shopProductId: milkSp.id, quantity: 3 });
    await addItem(listId, { shopProductId: paneerSp.id, quantity: 2 });
    const check = await call(checkRoute, `/api/purchase-lists/${listId}/check`, { params: { id: listId } });
    expect(check.body.cartItemCount).toBe(0);

    await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: {}, params: { id: listId } });
    const cart = await getCart(customer.id);
    expect(cart.grandTotalPaise).toBe(check.body.preview.grandTotalPaise);
    expect(cart.deliveryFeePaise).toBe(check.body.preview.deliveryFeePaise);
    expect(cart.itemCount).toBe(5);
  });

  it("ADD caps a line at 99 in the cart; a line short of stock is left out and reported", async () => {
    const { customer, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Monthly" });
    await addItem(listId, { shopProductId: milkSp.id, quantity: 2 });
    await addItem(listId, { shopProductId: curdSp.id, quantity: 2 }); // 2 in stock
    await addToCart(customer.id, curdSp.id, 1); // 1 + 2 > stock

    const r = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: listId } });
    expect(r.status).toBe(200);
    expect(r.body.added.map((a: { productName: string }) => a.productName)).toEqual(["Cow Milk"]);
    expect(r.body.notAdded).toEqual([expect.objectContaining({ productName: "Curd", reason: "Only 2 left in stock." })]);
    expect(await cartLines(customer.id)).toEqual([["Cow Milk", 2], ["Curd", 1]]);
  });

  it("refuses an unknown mode (422) and orders nothing", async () => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    await addItem(listId, { shopProductId: milkSp.id });
    for (const body of [{ mode: "MERGE" }, { mode: "add" }, { mode: 1 }]) {
      const r = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body, params: { id: listId } });
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect(await cartLines(customer.id)).toEqual([]);
  });

  it("refuses a list with nothing to order (422) and leaves it unordered", async () => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    const empty = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: listId } });
    expect(empty.status).toBe(422);
    const itemId = (await addItem(listId, { shopProductId: milkSp.id, quantity: 0 })).body.item.itemId;
    expect(itemId).toBeTruthy();
    const skipped = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: listId } });
    expect(skipped.status).toBe(422);
    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, listId));
    expect(row.lastOrderedAt).toBeNull();
  });

  // Regression (purchase lists QA, 24 Oct 2026, fixed): REPLACE deletes the cart's lines inside the
  // transaction, and "Nothing to order" is thrown only after it has committed — so the customer
  // gets a 422 and has lost their cart.
  it("REPLACE with nothing to order answers 422 and leaves the cart as it was", async () => {
    const { customer, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    await addItem(listId, { shopProductId: milkSp.id, quantity: 0 });
    await addToCart(customer.id, curdSp.id, 1);

    const r = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "REPLACE" }, params: { id: listId } });
    expect(r.status).toBe(422);
    expect(await cartLines(customer.id)).toEqual([["Curd", 1]]);
  });

  // Regression (purchase lists QA, 24 Oct 2026, fixed): when no line of the list can be added (all
  // out of stock / no longer sold), REPLACE still empties the cart and answers 200 with added: [].
  it("REPLACE where no line can be added leaves the cart as it was", async () => {
    const { customer, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Weekly" });
    await addItem(listId, { shopProductId: curdSp.id, quantity: 5 }); // only 2 in stock
    await addToCart(customer.id, milkSp.id, 3);

    const r = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode: "REPLACE" }, params: { id: listId } });
    expect(r.body.added).toEqual([]);
    expect(await cartLines(customer.id)).toEqual([["Cow Milk", 3]]);
  });

  it("answers 404 for another customer's list on check and order, and never touches either cart", async () => {
    const { customer, other, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Mine" });
    await addItem(listId, { shopProductId: milkSp.id, quantity: 2 });
    await addToCart(customer.id, curdSp.id, 1);
    await addToCart(other.id, curdSp.id, 1);

    signInAs(other);
    expect((await call(checkRoute, `/api/purchase-lists/${listId}/check`, { params: { id: listId } })).status).toBe(404);
    expect((await call(checkRoute, `/api/purchase-lists/${MALFORMED_ID}/check`, { params: { id: MALFORMED_ID } })).status).toBe(404);
    for (const mode of ["ADD", "REPLACE"]) {
      const r = await call(orderRoute, `/api/purchase-lists/${listId}/order`, { method: "POST", body: { mode }, params: { id: listId } });
      expect(r.status, mode).toBe(404);
    }
    expect((await call(orderRoute, `/api/purchase-lists/${MALFORMED_ID}/order`, { method: "POST", body: { mode: "ADD" }, params: { id: MALFORMED_ID } })).status).toBe(404);
    expect(await cartLines(other.id)).toEqual([["Curd", 1]]);
    expect(await cartLines(customer.id)).toEqual([["Curd", 1]]);
    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, listId));
    expect(row.lastOrderedAt).toBeNull();
  });
});

/* ---------------------------------------------------------- save the cart */

describe("POST /api/purchase-lists/from-cart", () => {
  it("saves the cart as a new list (201), then into that list taking the cart's quantities", async () => {
    const { customer, milkSp, curdSp } = await setup();
    signInAs(customer);
    await addToCart(customer.id, milkSp.id, 2);

    const created = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { name: "From my cart", kind: "SHOPPING", frequency: "WEEKLY" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "From my cart", frequency: "WEEKLY", itemCount: 1 });
    expect(created.body.items.map((i: { productName: string; quantity: number }) => [i.productName, i.quantity])).toEqual([["Cow Milk", 2]]);

    await addToCart(customer.id, milkSp.id, 3);
    await addToCart(customer.id, curdSp.id, 1);
    const merged = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { listId: created.body.id } });
    expect(merged.status).toBe(201);
    expect(merged.body.items.map((i: { productName: string; quantity: number }) => [i.productName, i.quantity]).sort()).toEqual([["Cow Milk", 5], ["Curd", 1]]);
    // The cart itself is untouched.
    expect(await cartLines(customer.id)).toEqual([["Cow Milk", 5], ["Curd", 1]]);
  });

  it("keeps a note and the other products already on an existing list", async () => {
    const { customer, milkSp, paneerSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Monthly" });
    await addItem(listId, { shopProductId: milkSp.id, quantity: 1, note: "Toned" });
    await addItem(listId, { shopProductId: paneerSp.id, quantity: 4 });
    await addToCart(customer.id, milkSp.id, 3);

    const r = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { listId } });
    expect(r.status).toBe(201);
    expect(r.body.items.map((i: { productName: string; quantity: number; note: string | null }) => [i.productName, i.quantity, i.note])).toEqual([
      ["Cow Milk", 3, "Toned"],
      ["Paneer", 4, null],
    ]);
  });

  it("refuses an empty cart (422), a name already used (409), and creates nothing", async () => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    const empty = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { name: "Nothing" } });
    expect(empty.status).toBe(422);
    expect(await db.select().from(purchaseLists)).toHaveLength(0);

    await createList({ name: "Weekly" });
    await addToCart(customer.id, milkSp.id, 1);
    const dup = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { name: "weekly" } });
    expect(dup.status).toBe(409);
    expect(await db.select().from(purchaseLists)).toHaveLength(1);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });

  it.each([
    ["no target at all", {}],
    ["a malformed list id", { listId: "abc" }],
    ["an empty name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["an unknown kind", { name: "Weekly", kind: "FOOD" }],
    ["an unknown frequency", { name: "Weekly", frequency: "DAILY" }],
  ])("refuses %s with 422", async (_what, body) => {
    const { customer, milkSp } = await setup();
    signInAs(customer);
    await addToCart(customer.id, milkSp.id, 1);
    const r = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body });
    expect(r.status).toBe(422);
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
  });

  it("answers 404 for another customer's list and leaves it untouched", async () => {
    const { customer, other, milkSp, curdSp } = await setup();
    signInAs(customer);
    const listId = await createList({ name: "Mine" });
    await addItem(listId, { shopProductId: curdSp.id, quantity: 1 });

    signInAs(other);
    await addToCart(other.id, milkSp.id, 2);
    const r = await call(fromCartRoute, "/api/purchase-lists/from-cart", { method: "POST", body: { listId } });
    expect(r.status).toBe(404);
    const items = await db.select().from(purchaseListItems);
    expect(items).toHaveLength(1);
    expect(items[0].shopProductId).toBe(curdSp.id);
  });
});
