/**
 * Purchase lists (docs/purchase-lists-2026-10): a customer's named weekly /
 * monthly lists — shopping or medicines — whose quantities they update each
 * time, check at live prices, and send to the cart to order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { notifications, purchaseListItems, purchaseLists, shopProducts, shops } from "@/server/db/schema";
import { addToCart, getCart } from "@/server/services/cart";
import {
  addPurchaseListItem,
  checkPurchaseList,
  createPurchaseList,
  deletePurchaseList,
  getPurchaseList,
  listPurchaseLists,
  removePurchaseListItem,
  saveCartToList,
  sendPurchaseListReminders,
  sendPurchaseListToCart,
  updatePurchaseList,
  updatePurchaseListItem,
} from "@/server/services/purchase-lists";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

/** `count` shop products of one shop, priced ₹1, for the size limits. */
async function manyShopProducts(count: number) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Bulk" });
  const shop = await createShop(owner.id, { name: "Bulk Store" });
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const product = await createProduct(category.id, { name: `Item ${String(i).padStart(3, "0")}`, unit: "pc" });
    out.push(await createShopProduct(shop.id, product.id, { onlinePricePaise: 100, onlineStock: 500 }));
  }
  return out;
}

beforeEach(resetDatabase);

async function setup() {
  const customer = await createUser();
  const owner = await createUser({ role: "SHOP_OWNER" });
  const milkCategory = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(milkCategory.id, { name: "Cow Milk", unit: "L" });
  const curd = await createProduct(milkCategory.id, { name: "Curd", unit: "kg" });
  const tablets = await createProduct(milkCategory.id, { name: "Paracetamol 500", unit: "pc" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const curdSp = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 9000, onlineStock: 2 });
  const tabletSp = await createShopProduct(shop.id, tablets.id, { onlinePricePaise: 3000, onlineStock: 40 });
  return { customer, shop, milkSp, curdSp, tabletSp };
}

describe("lists", () => {
  it("creates named weekly and monthly lists, shopping and medicines, and lists them", async () => {
    const { customer } = await setup();
    const monthly = await createPurchaseList(customer.id, { name: "  Monthly   groceries ", frequency: "MONTHLY" });
    const meds = await createPurchaseList(customer.id, { name: "Papa's BP tablets", kind: "MEDICINE", frequency: "WEEKLY" });

    expect(monthly).toMatchObject({ name: "Monthly groceries", kind: "SHOPPING", frequency: "MONTHLY", remind: true, itemCount: 0 });
    expect(meds).toMatchObject({ kind: "MEDICINE", frequency: "WEEKLY" });
    // Due a week / a month after creation until first ordered.
    expect(meds.nextDueAt.getTime() - meds.createdAt.getTime()).toBe(7 * 24 * 3600 * 1000);

    const lists = await listPurchaseLists(customer.id);
    expect(lists.map((l) => l.name)).toEqual(["Monthly groceries", "Papa's BP tablets"]);
  });

  it("refuses a second list with the same name (any case), and an empty name", async () => {
    const { customer } = await setup();
    await createPurchaseList(customer.id, { name: "Weekly" });
    await expect(createPurchaseList(customer.id, { name: "weekly" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createPurchaseList(customer.id, { name: "   " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Another customer may use the same name.
    const other = await createUser();
    await expect(createPurchaseList(other.id, { name: "Weekly" })).resolves.toBeTruthy();
  });

  it("renames and changes a list; another customer's list is not found", async () => {
    const { customer } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Groceries" });
    const updated = await updatePurchaseList(customer.id, list.id, { name: "Monthly kirana", frequency: "WEEKLY", remind: false });
    expect(updated).toMatchObject({ name: "Monthly kirana", frequency: "WEEKLY", remind: false });

    const other = await createUser();
    await expect(getPurchaseList(other.id, list.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updatePurchaseList(other.id, list.id, { name: "Mine" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deletePurchaseList(other.id, list.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes a list with its items", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 2 });
    await deletePurchaseList(customer.id, list.id);
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
    expect(await db.select().from(purchaseListItems)).toHaveLength(0);
  });
});

describe("items", () => {
  it("adds products with a note, keeps a product already on the list as it was, and updates quantities", async () => {
    const { customer, milkSp, tabletSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Meds", kind: "MEDICINE" });

    const first = await addPurchaseListItem(customer.id, list.id, { shopProductId: tabletSp.id, quantity: 2, note: "1 after breakfast" });
    expect(first.alreadyOnList).toBe(false);
    expect(first.item).toMatchObject({ productName: "Paracetamol 500", quantity: 2, note: "1 after breakfast", purchasable: true, unitPricePaise: 3000 });

    const again = await addPurchaseListItem(customer.id, list.id, { shopProductId: tabletSp.id, quantity: 5 });
    expect(again.alreadyOnList).toBe(true);
    expect(again.item.quantity).toBe(2);

    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id });
    const updated = await updatePurchaseListItem(customer.id, list.id, first.item.itemId, { quantity: 4, note: "" });
    expect(updated).toMatchObject({ quantity: 4, note: null });

    const detail = await getPurchaseList(customer.id, list.id);
    expect(detail.items.map((i) => [i.productName, i.quantity])).toEqual([["Paracetamol 500", 4], ["Cow Milk", 1]]);
    expect(detail.estimatedSubtotalPaise).toBe(4 * 3000 + 7000);
  });

  it("quantity 0 keeps the item on the list but leaves it out this time", async () => {
    const { customer, milkSp, curdSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 3 });
    const curd = await addPurchaseListItem(customer.id, list.id, { shopProductId: curdSp.id, quantity: 1 });
    await updatePurchaseListItem(customer.id, list.id, curd.item.itemId, { quantity: 0 });

    const check = await checkPurchaseList(customer.id, list.id);
    expect(check.skipped.map((s) => s.productName)).toEqual(["Curd"]);
    expect(check.preview.groups[0].lines.map((l) => l.productName)).toEqual(["Cow Milk"]);
    expect((await listPurchaseLists(customer.id))[0]).toMatchObject({ itemCount: 2, activeItemCount: 1 });
  });

  it("rejects bad quantities, an unknown product and another customer's item", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await expect(addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 100 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(addPurchaseListItem(customer.id, list.id, { shopProductId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { item } = await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id });
    const other = await createUser();
    const otherList = await createPurchaseList(other.id, { name: "Mine" });
    await expect(updatePurchaseListItem(other.id, otherList.id, item.itemId, { quantity: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removePurchaseListItem(other.id, otherList.id, item.itemId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await removePurchaseListItem(customer.id, list.id, item.itemId);
    expect((await getPurchaseList(customer.id, list.id)).items).toHaveLength(0);
  });

  it("shows a product the shop has since removed as no longer sold, and leaves it out of the order", async () => {
    const { customer, milkSp, curdSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 1 });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: curdSp.id, quantity: 1 });
    await db.delete(shopProducts).where(eq(shopProducts.id, curdSp.id));

    const detail = await getPurchaseList(customer.id, list.id);
    expect(detail.items.find((i) => i.shopProductId === curdSp.id)).toMatchObject({ exists: false, purchasable: false });
    expect((await checkPurchaseList(customer.id, list.id)).missing).toHaveLength(1);

    const result = await sendPurchaseListToCart(customer.id, list.id, "ADD");
    expect(result.added.map((a) => a.productName)).toEqual(["Cow Milk"]);
    expect(result.notAdded).toHaveLength(1);
  });
});

describe("check and order", () => {
  it("checks the list at live prices and delivery fees, as the cart would price it", async () => {
    const { customer, milkSp, tabletSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Monthly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 2 });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: tabletSp.id, quantity: 3 });
    // The price changes after the item was saved: the check uses today's price.
    await db.update(shopProducts).set({ onlinePricePaise: 7500 }).where(eq(shopProducts.id, milkSp.id));

    const check = await checkPurchaseList(customer.id, list.id);
    expect(check.preview.subtotalPaise).toBe(2 * 7500 + 3 * 3000);
    expect(check.preview.grandTotalPaise).toBe(check.preview.subtotalPaise + check.preview.deliveryFeePaise);
    expect(check.cartItemCount).toBe(0);

    // Same totals as the cart once it is there.
    await sendPurchaseListToCart(customer.id, list.id, "ADD");
    const cart = await getCart(customer.id);
    expect(cart.grandTotalPaise).toBe(check.preview.grandTotalPaise);
    expect(cart.itemCount).toBe(5);
  });

  it("adds to the cart or replaces it, and marks the list ordered", async () => {
    const { customer, milkSp, curdSp, tabletSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly", frequency: "WEEKLY" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 2 });
    await addToCart(customer.id, milkSp.id, 1);
    await addToCart(customer.id, curdSp.id, 1);

    const added = await sendPurchaseListToCart(customer.id, list.id, "ADD");
    expect(added.cartItemCount).toBe(4); // 1 + 2 milk, 1 curd
    let cart = await getCart(customer.id);
    expect(cart.groups[0].lines.find((l) => l.productName === "Cow Milk")?.quantity).toBe(3);

    await addPurchaseListItem(customer.id, list.id, { shopProductId: tabletSp.id, quantity: 1 });
    const replaced = await sendPurchaseListToCart(customer.id, list.id, "REPLACE");
    expect(replaced.cartItemCount).toBe(3);
    cart = await getCart(customer.id);
    expect(cart.groups[0].lines.map((l) => [l.productName, l.quantity]).sort()).toEqual([["Cow Milk", 2], ["Paracetamol 500", 1]]);

    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, list.id));
    expect(row.lastOrderedAt).not.toBeNull();
    const summary = (await listPurchaseLists(customer.id))[0];
    expect(summary.nextDueAt.getTime() - row.lastOrderedAt!.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("leaves out and reports a line that cannot be bought at that quantity, without changing it", async () => {
    const { customer, milkSp, curdSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 1 });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: curdSp.id, quantity: 5 }); // only 2 in stock

    const check = await checkPurchaseList(customer.id, list.id);
    expect(check.preview.hasUnavailableItems).toBe(true);
    expect(check.preview.groups[0].lines.find((l) => l.productName === "Curd")).toMatchObject({ purchasable: false, unavailableReason: "Only 2 left in stock." });

    const result = await sendPurchaseListToCart(customer.id, list.id, "ADD");
    expect(result.added.map((a) => a.productName)).toEqual(["Cow Milk"]);
    expect(result.notAdded).toEqual([expect.objectContaining({ productName: "Curd", reason: "Only 2 left in stock." })]);
    expect((await getPurchaseList(customer.id, list.id)).items.find((i) => i.productName === "Curd")?.quantity).toBe(5);
  });

  it("refuses to order a list with nothing to order", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await expect(sendPurchaseListToCart(customer.id, list.id, "ADD")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const { item } = await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id });
    await updatePurchaseListItem(customer.id, list.id, item.itemId, { quantity: 0 });
    await expect(sendPurchaseListToCart(customer.id, list.id, "ADD")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [row] = await db.select().from(purchaseLists).where(eq(purchaseLists.id, list.id));
    expect(row.lastOrderedAt).toBeNull();
  });
});

describe("save cart as a list", () => {
  it("saves the cart into a new list, then into an existing one taking the cart's quantities", async () => {
    const { customer, milkSp, curdSp } = await setup();
    await addToCart(customer.id, milkSp.id, 2);
    const created = await saveCartToList(customer.id, { name: "From my cart", frequency: "WEEKLY" });
    expect(created.items.map((i) => [i.productName, i.quantity])).toEqual([["Cow Milk", 2]]);

    await addToCart(customer.id, milkSp.id, 1);
    await addToCart(customer.id, curdSp.id, 1);
    const merged = await saveCartToList(customer.id, { listId: created.id });
    expect(merged.items.map((i) => [i.productName, i.quantity]).sort()).toEqual([["Cow Milk", 3], ["Curd", 1]]);
  });

  it("refuses an empty cart", async () => {
    const { customer } = await setup();
    await expect(saveCartToList(customer.id, { name: "Empty" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
  });
});

describe("reminders", () => {
  it("reminds once when a list is due, and not before or for a list without items", async () => {
    const { customer, milkSp } = await setup();
    const weekly = await createPurchaseList(customer.id, { name: "Weekly", frequency: "WEEKLY" });
    await createPurchaseList(customer.id, { name: "Empty", frequency: "WEEKLY" });
    await addPurchaseListItem(customer.id, weekly.id, { shopProductId: milkSp.id, quantity: 2 });

    expect(await sendPurchaseListReminders(new Date(Date.now() + 2 * 24 * 3600 * 1000))).toEqual({ reminded: 0 });

    const dueDay = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    expect(await sendPurchaseListReminders(dueDay)).toEqual({ reminded: 1 });
    expect(await sendPurchaseListReminders(dueDay)).toEqual({ reminded: 0 });

    const sent = await db.select().from(notifications).where(eq(notifications.userId, customer.id));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "list.due", title: "Time to reorder: Weekly", actionUrl: `/lists/${weekly.id}` });
  });

  it("does not remind for a list with the reminder off", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Monthly", remind: false });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id });
    expect(await sendPurchaseListReminders(new Date(Date.now() + 40 * 24 * 3600 * 1000))).toEqual({ reminded: 0 });
  });
});

describe("QA additions (purchase lists, 24 Oct 2026)", () => {
  it("a list holds up to 100 products: the 101st is refused and nothing is added", async () => {
    const customer = await createUser();
    const sps = await manyShopProducts(101);
    const list = await createPurchaseList(customer.id, { name: "Big" });
    for (const sp of sps.slice(0, 100)) await addPurchaseListItem(customer.id, list.id, { shopProductId: sp.id });
    await expect(addPurchaseListItem(customer.id, list.id, { shopProductId: sps[100].id })).rejects.toMatchObject({ code: "CONFLICT" });
    // A product already on a full list is still answered as "already on it", not refused.
    await expect(addPurchaseListItem(customer.id, list.id, { shopProductId: sps[0].id })).resolves.toMatchObject({ alreadyOnList: true });
    expect(await db.select().from(purchaseListItems)).toHaveLength(100);
  }, 180_000);

  it("saving a cart into an existing list that would pass 100 products is refused and changes nothing", async () => {
    const customer = await createUser();
    const sps = await manyShopProducts(102);
    const list = await createPurchaseList(customer.id, { name: "Nearly full" });
    for (const sp of sps.slice(0, 99)) await addPurchaseListItem(customer.id, list.id, { shopProductId: sp.id, quantity: 1 });
    await addToCart(customer.id, sps[0].id, 7); // already on the list
    await addToCart(customer.id, sps[100].id, 1);
    await addToCart(customer.id, sps[101].id, 1);

    await expect(saveCartToList(customer.id, { listId: list.id })).rejects.toMatchObject({ code: "CONFLICT" });
    const items = await db.select().from(purchaseListItems);
    expect(items).toHaveLength(99);
    expect(items.find((i) => i.shopProductId === sps[0].id)?.quantity).toBe(1);
  }, 180_000);

  // Regression (purchase lists QA, 24 Oct 2026, fixed): saveCartToList creates the new list before
  // the transaction that fills it, so when filling fails (e.g. a cart of more than 100 products) an
  // empty list is left behind under the customer's chosen name.
  it("saving a too-big cart as a NEW list is refused and leaves no empty list behind", async () => {
    const customer = await createUser();
    const sps = await manyShopProducts(101);
    for (const sp of sps) await addToCart(customer.id, sp.id, 1);
    await expect(saveCartToList(customer.id, { name: "Everything" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(purchaseLists)).toHaveLength(0);
  }, 180_000);

  it("a shop that stops taking orders: the check shows its lines unavailable and the order leaves them out", async () => {
    const { customer, shop, milkSp } = await setup();
    const owner2 = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "BAKERY", name: "Bread" });
    const bread = await createProduct(category.id, { name: "Brown Bread", unit: "pc" });
    const bakery = await createShop(owner2.id, { name: "Bakery Two" });
    const breadSp = await createShopProduct(bakery.id, bread.id, { onlinePricePaise: 4500, onlineStock: 20 });
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 1 });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: breadSp.id, quantity: 2 });
    await db.update(shops).set({ status: "SUSPENDED" }).where(eq(shops.id, shop.id));

    const check = await checkPurchaseList(customer.id, list.id);
    expect(check.preview.groups).toHaveLength(2);
    const milkLine = check.preview.groups.flatMap((g) => g.lines).find((l) => l.productName === "Cow Milk");
    expect(milkLine).toMatchObject({ purchasable: false, unavailableReason: "This shop is not accepting orders." });
    expect(check.preview.subtotalPaise).toBe(2 * 4500);

    const result = await sendPurchaseListToCart(customer.id, list.id, "ADD");
    expect(result.added.map((a) => a.productName)).toEqual(["Brown Bread"]);
    expect(result.notAdded).toEqual([expect.objectContaining({ productName: "Cow Milk", reason: "This shop is not accepting orders." })]);
  });

  it("an item whose product is out of stock is still shown on the list, with the reason", async () => {
    const { customer, curdSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: curdSp.id, quantity: 1 });
    await db.update(shopProducts).set({ onlineStock: 0 }).where(eq(shopProducts.id, curdSp.id));
    const detail = await getPurchaseList(customer.id, list.id);
    expect(detail.items[0]).toMatchObject({ exists: true, purchasable: false, unavailableReason: "Out of stock.", lineTotalPaise: 0 });
    expect(detail.estimatedSubtotalPaise).toBe(0);
  });

  // Regression (purchase lists QA, 24 Oct 2026, fixed): ADD caps a cart line at 99 silently — the
  // result still says the list's full quantity was added. The spec says a line is never silently
  // changed.
  it("ADD never claims more units than it put in the cart (cart line capped at 99)", async () => {
    const { customer, milkSp } = await setup();
    await db.update(shopProducts).set({ onlineStock: 500 }).where(eq(shopProducts.id, milkSp.id));
    await addToCart(customer.id, milkSp.id, 98);
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 5 });

    const result = await sendPurchaseListToCart(customer.id, list.id, "ADD");
    const cart = await getCart(customer.id);
    const inCart = cart.groups[0].lines[0].quantity;
    const claimed = result.added.find((a) => a.productName === "Cow Milk")?.quantity ?? 0;
    expect(claimed).toBe(inCart - 98);
  });

  it("deleting a list leaves the cart alone", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 2 });
    await sendPurchaseListToCart(customer.id, list.id, "ADD");
    await deletePurchaseList(customer.id, list.id);
    expect((await getCart(customer.id)).itemCount).toBe(2);
  });

  it("reminds again for the next due date after the list is ordered", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly", frequency: "WEEKLY" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 1 });
    const day = 24 * 3600 * 1000;

    expect(await sendPurchaseListReminders(new Date(Date.now() + 8 * day))).toEqual({ reminded: 1 });
    // Ordered on day 9: due again on day 16.
    await db.update(purchaseLists).set({ lastOrderedAt: new Date(Date.now() + 9 * day) }).where(eq(purchaseLists.id, list.id));
    expect(await sendPurchaseListReminders(new Date(Date.now() + 12 * day))).toEqual({ reminded: 0 });
    expect(await sendPurchaseListReminders(new Date(Date.now() + 17 * day))).toEqual({ reminded: 1 });
    expect(await sendPurchaseListReminders(new Date(Date.now() + 18 * day))).toEqual({ reminded: 0 });
    expect(await db.select().from(notifications).where(eq(notifications.userId, customer.id))).toHaveLength(2);
  });

  it("does not remind for a list whose products are all skipped (quantity 0)", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Monthly" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 0 });
    expect(await sendPurchaseListReminders(new Date(Date.now() + 40 * 24 * 3600 * 1000))).toEqual({ reminded: 0 });
  });

  it("a re-run after a lost lastRemindedAt write never sends the same reminder twice (dedupe key)", async () => {
    const { customer, milkSp } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Weekly", frequency: "WEEKLY" });
    await addPurchaseListItem(customer.id, list.id, { shopProductId: milkSp.id, quantity: 1 });
    const due = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    await sendPurchaseListReminders(due);
    await db.update(purchaseLists).set({ lastRemindedAt: null }).where(eq(purchaseLists.id, list.id));
    await sendPurchaseListReminders(due);
    expect(await db.select().from(notifications).where(eq(notifications.userId, customer.id))).toHaveLength(1);
  });

  it("only the owner's lists are reminded, each to its own owner", async () => {
    const { customer, milkSp } = await setup();
    const other = await createUser();
    const a = await createPurchaseList(customer.id, { name: "Mine", frequency: "WEEKLY" });
    const b = await createPurchaseList(other.id, { name: "Theirs", frequency: "WEEKLY" });
    await addPurchaseListItem(customer.id, a.id, { shopProductId: milkSp.id });
    await addPurchaseListItem(other.id, b.id, { shopProductId: milkSp.id });
    expect(await sendPurchaseListReminders(new Date(Date.now() + 8 * 24 * 3600 * 1000))).toEqual({ reminded: 2 });
    const sent = await db.select().from(notifications);
    expect(sent.map((n) => [n.userId, n.actionUrl]).sort()).toEqual([[customer.id, `/lists/${a.id}`], [other.id, `/lists/${b.id}`]].sort());
  });

  it("changing the frequency moves the due date", async () => {
    const { customer } = await setup();
    const list = await createPurchaseList(customer.id, { name: "Monthly" });
    const weekly = await updatePurchaseList(customer.id, list.id, { frequency: "WEEKLY" });
    expect(weekly.nextDueAt.getTime() - weekly.createdAt.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});
