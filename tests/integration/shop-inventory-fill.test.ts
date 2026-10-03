/**
 * Adding a product category fills the shop's inventory, loose goods stay
 * unpriced, and an owner's prices are their shop's alone:
 *   - every live product of the category is listed with stock 100 on both channels;
 *   - a packaged product with an MRP starts at that MRP and on sale;
 *   - a loose product, or one without an MRP, starts with no price and off sale;
 *   - a product the shop already has keeps its own stock and price;
 *   - the owner's prices change only their shop's listings — never the master
 *     MRP or another shop's price — and must be greater than 0.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { PATCH as pricesPatch } from "@/app/api/shops/[id]/prices/route";
import { POST as shopCategoryPost } from "@/app/api/shops/[id]/product-categories/route";
import { db } from "@/server/db";
import { products, shopProductCategories, shopProducts } from "@/server/db/schema";
import { listStorefrontProducts, loadPurchasableShopProduct } from "@/server/services/catalogue";
import { changeMasterMrp } from "@/server/services/mrp-governance";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function listing(shopId: string, productId: string) {
  const [row] = await db
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId)));
  return row;
}

/** A category holding a packaged product with an MRP, one without, and a loose one (whose MRP must be ignored). */
async function grocerySetup() {
  const category = await createCategory({ name: "Grocery" });
  const biscuits = await createProduct(category.id, { name: "Biscuits", unit: "pack" });
  await db.update(products).set({ mrpPaise: 3000 }).where(eq(products.id, biscuits.id));
  const noMrp = await createProduct(category.id, { name: "Local Namkeen", unit: "pack" });
  const rice = await createProduct(category.id, { name: "Loose Rice", unit: "kg" });
  await db.update(products).set({ kind: "LOOSE", mrpPaise: 9999 }).where(eq(products.id, rice.id));
  await db.insert(products).values({ categoryId: category.id, name: "Pending Item", slug: "pending-item", unit: "pack", approvalStatus: "PENDING_APPROVAL" });
  return { category, biscuits, noMrp, rice };
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

describe("adding a category fills the shop's inventory", () => {
  it("lists every live product with stock 100, MRP as the price, loose goods unpriced", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const { category, biscuits, noMrp, rice } = await grocerySetup();
    signIn(owner);

    const res = await call(shopCategoryPost, `/api/shops/${shop.id}/product-categories`, {
      method: "POST",
      body: { categoryId: category.id },
      params: { id: shop.id },
    });
    expect(res.status).toBe(201);
    expect(res.body.addedProducts).toBe(3);
    expect(res.body.needsPrice.map((p: { productName: string }) => p.productName).sort()).toEqual(["Local Namkeen", "Loose Rice"]);

    expect(await listing(shop.id, biscuits.id)).toMatchObject({
      onlineStock: 100,
      offlineStock: 100,
      onlinePricePaise: 3000,
      offlinePricePaise: 3000,
      onlineSaleEnabled: true,
      offlineSaleEnabled: true,
    });
    for (const unpriced of [noMrp, rice]) {
      expect(await listing(shop.id, unpriced.id)).toMatchObject({
        onlineStock: 100,
        offlineStock: 100,
        onlinePricePaise: null,
        offlinePricePaise: null,
        onlineSaleEnabled: false,
        offlineSaleEnabled: false,
      });
    }
    expect(await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id))).toHaveLength(3);
  });

  it("keeps the stock and price of a product the shop already has, and adds no duplicate", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const { category, biscuits } = await grocerySetup();
    await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 2500, offlinePricePaise: 2400, onlineStock: 7 });
    // The fixture links the category; start from a shop that does not carry it yet.
    await db.delete(shopProductCategories).where(eq(shopProductCategories.shopId, shop.id));
    signIn(owner);

    const res = await call(shopCategoryPost, `/api/shops/${shop.id}/product-categories`, {
      method: "POST",
      body: { categoryId: category.id },
      params: { id: shop.id },
    });
    expect(res.body.addedProducts).toBe(2);
    expect(await listing(shop.id, biscuits.id)).toMatchObject({ onlinePricePaise: 2500, offlinePricePaise: 2400, onlineStock: 7 });
    expect(await db.select().from(shopProducts).where(eq(shopProducts.productId, biscuits.id))).toHaveLength(1);
  });

  it("shows an unpriced product to buyers without a price, and it cannot be bought", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED" });
    const { category, rice } = await grocerySetup();
    signIn(owner);
    await call(shopCategoryPost, `/api/shops/${shop.id}/product-categories`, {
      method: "POST",
      body: { categoryId: category.id },
      params: { id: shop.id },
    });

    const offers = await listStorefrontProducts({ shopId: shop.id, productId: rice.id });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ onlinePricePaise: null, offlinePricePaise: null, onlineSaleEnabled: false });
    await expect(loadPurchasableShopProduct(offers[0].shopProductId, 1)).rejects.toThrow();
  });
});

describe("an owner's prices are their shop's own", () => {
  async function twoShopsWithRice() {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id);
    const shopB = await createShop(ownerB.id);
    const { category, biscuits, rice } = await grocerySetup();
    for (const [owner, shop] of [[ownerA, shopA], [ownerB, shopB]] as const) {
      signIn(owner);
      await call(shopCategoryPost, `/api/shops/${shop.id}/product-categories`, {
        method: "POST",
        body: { categoryId: category.id },
        params: { id: shop.id },
      });
    }
    return { ownerA, ownerB, shopA, shopB, biscuits, rice };
  }

  it("saves several prices at once for this shop only; master MRP and other shops unchanged", async () => {
    const { ownerA, shopA, shopB, biscuits, rice } = await twoShopsWithRice();
    const riceA = await listing(shopA.id, rice.id);
    const biscuitsA = await listing(shopA.id, biscuits.id);
    signIn(ownerA);

    const res = await call(pricesPatch, `/api/shops/${shopA.id}/prices`, {
      method: "PATCH",
      body: {
        prices: [
          { shopProductId: riceA.id, pricePaise: 6000 },
          { shopProductId: biscuitsA.id, pricePaise: 2800 },
        ],
      },
      params: { id: shopA.id },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });

    // The first price puts the loose product on sale.
    expect(await listing(shopA.id, rice.id)).toMatchObject({
      onlinePricePaise: 6000,
      offlinePricePaise: 6000,
      onlineSaleEnabled: true,
      offlineSaleEnabled: true,
    });
    expect(await listing(shopA.id, biscuits.id)).toMatchObject({ onlinePricePaise: 2800, offlinePricePaise: 2800 });
    expect(await listing(shopB.id, rice.id)).toMatchObject({ onlinePricePaise: null, onlineSaleEnabled: false });
    expect(await listing(shopB.id, biscuits.id)).toMatchObject({ onlinePricePaise: 3000 });
    const [master] = await db.select().from(products).where(eq(products.id, biscuits.id));
    expect(master.mrpPaise).toBe(3000);
  });

  it("refuses a price of 0, a negative price or text, and saves none of the batch", async () => {
    const { ownerA, shopA, rice, biscuits } = await twoShopsWithRice();
    const riceA = await listing(shopA.id, rice.id);
    const biscuitsA = await listing(shopA.id, biscuits.id);
    signIn(ownerA);

    for (const bad of [0, -100, "abc"]) {
      const res = await call(pricesPatch, `/api/shops/${shopA.id}/prices`, {
        method: "PATCH",
        body: {
          prices: [
            { shopProductId: biscuitsA.id, pricePaise: 2000 },
            { shopProductId: riceA.id, pricePaise: bad },
          ],
        },
        params: { id: shopA.id },
      });
      expect(res.status).toBe(422);
    }
    expect(await listing(shopA.id, biscuits.id)).toMatchObject({ onlinePricePaise: 3000 });
    expect(await listing(shopA.id, rice.id)).toMatchObject({ onlinePricePaise: null });
  });

  it("refuses another shop's product, another owner's shop, and staff", async () => {
    const { ownerA, ownerB, shopA, shopB, rice } = await twoShopsWithRice();
    const riceB = await listing(shopB.id, rice.id);

    // Shop A's owner, naming shop B's listing through shop A.
    signIn(ownerA);
    const viaOwnShop = await call(pricesPatch, `/api/shops/${shopA.id}/prices`, {
      method: "PATCH",
      body: { prices: [{ shopProductId: riceB.id, pricePaise: 5000 }] },
      params: { id: shopA.id },
    });
    expect(viaOwnShop.status).toBe(403);

    // Shop A's owner, through shop B directly.
    const viaOtherShop = await call(pricesPatch, `/api/shops/${shopB.id}/prices`, {
      method: "PATCH",
      body: { prices: [{ shopProductId: riceB.id, pricePaise: 5000 }] },
      params: { id: shopB.id },
    });
    expect(viaOtherShop.status).toBe(403);

    // Staff change a shop's prices through the price-request flow, not here.
    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);
    const asAdmin = await call(pricesPatch, `/api/shops/${shopB.id}/prices`, {
      method: "PATCH",
      body: { prices: [{ shopProductId: riceB.id, pricePaise: 5000 }] },
      params: { id: shopB.id },
    });
    expect(asAdmin.status).toBe(403);

    expect(await listing(shopB.id, rice.id)).toMatchObject({ onlinePricePaise: null });
    void ownerB;
  });

  it("an admin's new master MRP leaves the prices shops already set", async () => {
    const { ownerA, shopA, shopB, biscuits } = await twoShopsWithRice();
    const biscuitsA = await listing(shopA.id, biscuits.id);
    signIn(ownerA);
    await call(pricesPatch, `/api/shops/${shopA.id}/prices`, {
      method: "PATCH",
      body: { prices: [{ shopProductId: biscuitsA.id, pricePaise: 2800 }] },
      params: { id: shopA.id },
    });

    const admin = await createUser({ role: "ADMIN" });
    await changeMasterMrp({ productId: biscuits.id, mrpPaise: 3500, source: "ADMIN" }, { id: admin.id, role: "ADMIN" });

    const [master] = await db.select().from(products).where(eq(products.id, biscuits.id));
    expect(master.mrpPaise).toBe(3500);
    expect(await listing(shopA.id, biscuits.id)).toMatchObject({ onlinePricePaise: 2800 });
    expect(await listing(shopB.id, biscuits.id)).toMatchObject({ onlinePricePaise: 3000 });
  });
});
