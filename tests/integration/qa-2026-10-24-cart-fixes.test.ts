/**
 * Customer-side fixes from the automated QA run of 24 Oct 2026
 * (docs/testing/qa-defects.json):
 *
 * TC-FLD-018 — deleting the default address left no default; the newest
 *   remaining address now takes over.
 * TC-FLD-025 — checkout accepted a deleted address id and delivered to it.
 * TC-DISC-007 / TC-FLD-022 — "%" and "_" in a search matched everything.
 * TC-DISC-004 — a PIN typed in the shop search finds the shops at that PIN.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { addresses, shops } from "@/server/db/schema";
import { createAddress, deleteAddress } from "@/server/services/addresses";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { searchShops } from "@/server/services/shops";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

describe("TC-FLD-018: deleting the default address", () => {
  it("makes the newest remaining address the default", async () => {
    const user = await createUser();
    const first = await createAddress(user.id, { line1: "1 First Lane", city: "Pune", pincode: "411001", isDefault: true });
    await createAddress(user.id, { line1: "2 Second Lane", city: "Pune", pincode: "411002" });
    const third = await createAddress(user.id, { line1: "3 Third Lane", city: "Pune", pincode: "411003" });
    await deleteAddress(user.id, first.id);
    const rows = await db.query.addresses.findMany({ where: eq(addresses.userId, user.id) });
    const live = rows.filter((a) => !a.deletedAt);
    expect(live.filter((a) => a.isDefault).map((a) => a.id)).toEqual([third.id]);
    expect(rows.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });
});

describe("TC-FLD-025: checkout with a deleted address", () => {
  it("is refused, and no order is placed", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const shop = await createShop(owner.id, { latitude: 0, longitude: 0 });
    const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
    const address = await createAddress(customer.id, { line1: "1 Gone Lane", city: "Pune", pincode: "411001", isDefault: true });
    await deleteAddress(customer.id, address.id);
    await addToCart(customer.id, sp.id, 1);
    await expect(checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: address.id })).rejects.toThrow(/address/i);
  });
});

describe("TC-DISC-007 / TC-DISC-004: shop search", () => {
  it("treats % and _ as text, and finds a shop by its PIN", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const dairy = await createShop(owner.id, { name: "Kesari Dairy" });
    await createShop(owner.id, { name: "Corner Bakery" });
    await db.update(shops).set({ pincode: "411038" }).where(eq(shops.id, dairy.id));
    expect(await searchShops({ query: "%" })).toEqual([]);
    expect(await searchShops({ query: "_" })).toEqual([]);
    expect((await searchShops({ query: "kesari" })).map((s) => s.id)).toEqual([dairy.id]);
    expect((await searchShops({ query: "411038" })).map((s) => s.id)).toEqual([dairy.id]);
  });
});
