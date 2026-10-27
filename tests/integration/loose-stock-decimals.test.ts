/**
 * D-95 / TC-SPI-025 (owner decision 25 Oct 2026): loose stock records decimals.
 * A listing's stock was a whole number of sellable units, so stock 2.5 of a
 * loose 1 kg listing was refused, a books count of 2.500 kg left 2, and 250 g
 * of it could not be sold. Loose goods now keep three decimals end to end —
 * owner's stock, the books, the cart, checkout and cancellation — while
 * packaged goods stay whole. The stock ledger (qty_milli) matches throughout.
 *
 * Runs on both layouts (one database, and the seller / customer split).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" | "SUSPENDED" | "DELETED" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as addRoute } from "@/app/api/cart/route";
import { PATCH as patchItemRoute } from "@/app/api/cart/items/[id]/route";
import { PATCH as patchListingRoute } from "@/app/api/shop-products/[id]/route";
import { adjustStockTo, ledgerDrift } from "@/server/accounts/stock";
import { db } from "@/server/db";
import { inventoryMovements, invStockLedger, orderItems, shopProducts, type User } from "@/server/db/schema";
import { getCart } from "@/server/services/cart";
import { cancelOrder, checkout } from "@/server/services/orders";
import { call } from "../helpers/http";
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

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

const signIn = (u: User) => {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
};

async function setup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 1_000_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "GROCERY_KIRANA", name: "Staples" });
  const jaggery = await createProduct(category.id, { name: "Loose Jaggery", unit: "kg", kind: "LOOSE", unitSizeMilli: 1000, subscribable: false });
  const biscuits = await createProduct(category.id, { name: "Biscuit Pack", unit: "pack", kind: "PACKAGED", subscribable: false });
  const shop = await createShop(owner.id, { name: "Kirana One" });
  const jaggerySp = await createShopProduct(shop.id, jaggery.id, { onlinePricePaise: 8000, onlineStock: 100 });
  const biscuitSp = await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 3000, onlineStock: 50 });
  return { customer, owner, shop, jaggerySp, biscuitSp, addressId: await deliveryAddressId(customer.id) };
}

const stockOf = async (id: string) => (await db.select().from(shopProducts).where(eq(shopProducts.id, id)))[0];
const ledgerTotal = async (id: string) =>
  (await db.select({ q: invStockLedger.qtyMilli }).from(invStockLedger).where(and(eq(invStockLedger.shopProductId, id), eq(invStockLedger.channel, "ONLINE")))).reduce(
    (n, r) => n + Number(r.q),
    0,
  );

describe("D-95: a loose listing's stock keeps decimals", () => {
  it("the owner sets 2.5 (the ledger records 2500 milli); a packaged product refuses 2.5", async () => {
    const { owner, jaggerySp, biscuitSp } = await setup();
    signIn(owner);
    const loose = await call(patchListingRoute, `/api/shop-products/${jaggerySp.id}`, { method: "PATCH", body: { onlineStock: 2.5 }, params: { id: jaggerySp.id } });
    expect(loose.status).toBe(200);
    expect((await stockOf(jaggerySp.id)).onlineStock).toBe(2.5);
    expect(await ledgerTotal(jaggerySp.id)).toBe(2500);
    const [movement] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, jaggerySp.id));
    expect([movement.previousUnits, movement.newUnits, movement.deltaUnits]).toEqual([100, 2.5, -97.5]);

    const packaged = await call(patchListingRoute, `/api/shop-products/${biscuitSp.id}`, { method: "PATCH", body: { onlineStock: 2.5 }, params: { id: biscuitSp.id } });
    expect(packaged.status).toBe(422);
    expect(packaged.body.error.message).toMatch(/whole number for a packaged product/);
    expect((await stockOf(biscuitSp.id)).onlineStock).toBe(50);

    const tooFine = await call(patchListingRoute, `/api/shop-products/${jaggerySp.id}`, { method: "PATCH", body: { onlineStock: 2.0005 }, params: { id: jaggerySp.id } });
    expect(tooFine.status).toBe(422);
    expect(tooFine.body.error.message).toMatch(/at most 3 decimals/);
  });

  it("a books count of 2.500 kg leaves sellable stock at 2.5, not 2, and the books agree", async () => {
    const { owner, shop, jaggerySp } = await setup();
    await adjustStockTo(shop.id, jaggerySp.id, 2500, "count 2.5 kg", owner.id);
    expect((await stockOf(jaggerySp.id)).onlineStock).toBe(2.5);
    expect(await ledgerTotal(jaggerySp.id)).toBe(2500);
    expect(await ledgerDrift(shop.id)).toEqual([]);
  });

  it("250 g can be bought: the cart takes 0.25, checkout takes 0.25 off stock, a cancellation puts it back", async () => {
    const { customer, owner, jaggerySp, biscuitSp, addressId } = await setup();
    signIn(owner);
    await call(patchListingRoute, `/api/shop-products/${jaggerySp.id}`, { method: "PATCH", body: { onlineStock: 2.5 }, params: { id: jaggerySp.id } });

    signIn(customer);
    const added = await call(addRoute, "/api/cart", { method: "POST", body: { shopProductId: jaggerySp.id, quantity: 0.25 } });
    expect(added.status).toBe(200);
    const [line] = (await getCart(customer.id)).groups.flatMap((g) => g.lines);
    expect([line.quantity, line.kind, line.quantityStep, line.lineTotalPaise]).toEqual([0.25, "LOOSE", 0.25, 2000]);
    expect(added.body.itemCount).toBe(1); // a loose line counts once in the badge

    // The cart page's − / + steps: 0.25 → 0.5 → 0.25.
    expect((await call(patchItemRoute, `/api/cart/items/${line.cartItemId}`, { method: "PATCH", body: { quantity: 0.5 }, params: { id: line.cartItemId } })).status).toBe(200);
    expect((await call(patchItemRoute, `/api/cart/items/${line.cartItemId}`, { method: "PATCH", body: { quantity: 0.25 }, params: { id: line.cartItemId } })).status).toBe(200);

    // A packaged product still takes whole units only.
    const quarterPack = await call(addRoute, "/api/cart", { method: "POST", body: { shopProductId: biscuitSp.id, quantity: 0.25 } });
    expect(quarterPack.status).toBe(422);
    expect(quarterPack.body.error.message).toMatch(/whole number from 1 to 99/);

    const { orders } = await checkout({ userId: customer.id, addressId, requestId: "d95-quarter" });
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orders[0].id));
    expect([item.quantityMilli, item.lineTotalPaise]).toEqual([250, 2000]);
    expect((await stockOf(jaggerySp.id)).onlineStock).toBe(2.25);
    expect(await ledgerTotal(jaggerySp.id)).toBe(2250);
    const sale = await db.select().from(invStockLedger).where(and(eq(invStockLedger.shopProductId, jaggerySp.id), eq(invStockLedger.movementType, "SALE")));
    expect(sale.map((r) => Number(r.qtyMilli))).toEqual([-250]);

    await cancelOrder(orders[0].id, { id: customer.id, role: "CUSTOMER" }, "Changed my mind");
    expect((await stockOf(jaggerySp.id)).onlineStock).toBe(2.5);
    expect(await ledgerTotal(jaggerySp.id)).toBe(2500);
  });

  it("refuses more than the stock left, naming the decimal amount", async () => {
    const { customer, owner, jaggerySp } = await setup();
    signIn(owner);
    await call(patchListingRoute, `/api/shop-products/${jaggerySp.id}`, { method: "PATCH", body: { onlineStock: 0.2 }, params: { id: jaggerySp.id } });
    signIn(customer);
    const res = await call(addRoute, "/api/cart", { method: "POST", body: { shopProductId: jaggerySp.id, quantity: 0.25 } });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Only 0\.2 left in stock/);
  });
});
