/**
 * Purchase lists (docs/purchase-lists-2026-10): a customer's named weekly /
 * monthly lists — shopping or medicines — whose quantities they update each
 * time, check at live prices, and send to the cart to order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { notifications, purchaseListItems, purchaseLists, shopProducts } from "@/server/db/schema";
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
