/**
 * F9 — home-page price comparison: the same product across nearby shops,
 * cheapest highlighted; loose goods with an empty price are skipped.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { platformSettings, products } from "@/server/db/schema";
import { homePriceComparison } from "@/server/services/price-comparison";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { saveShopOffer } from "@/server/services/shop-offers";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

const PUNE: CustomerLocation = {
  label: "PIN 411001",
  pincode: "411001",
  latitude: null,
  longitude: null,
  source: "PINCODE",
  addressId: null,
  societyId: null,
};

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "homePriceComparison"));
  await db.delete(platformSettings).where(eq(platformSettings.key, "shopOffers"));
  clearRuleCache();
});

async function scene() {
  const admin = await createUser({ role: "ADMIN" });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const paneer = await createProduct(cat.id, { name: "Loose Paneer", unit: "kg" });
  await db.update(products).set({ kind: "LOOSE" }).where(eq(products.id, paneer.id));
  const curd = await createProduct(cat.id, { name: "Curd", unit: "kg" });
  const a = await createShop(owner.id, { name: "Alpha Dairy" });
  const b = await createShop(owner.id, { name: "Beta Dairy" });
  const c = await createShop(owner.id, { name: "Gamma Dairy" });
  await createShopProduct(a.id, milk.id, { onlinePricePaise: 7200, onlineStock: 10 });
  await createShopProduct(b.id, milk.id, { onlinePricePaise: 6800, onlineStock: 10 });
  await createShopProduct(c.id, milk.id, { onlinePricePaise: 7000, onlineStock: 10 });
  // Loose goods: owners have not set a price yet.
  await createShopProduct(a.id, paneer.id, { onlinePricePaise: null, onlineSaleEnabled: false, onlineStock: 10 });
  await createShopProduct(b.id, paneer.id, { onlinePricePaise: null, onlineSaleEnabled: false, onlineStock: 10 });
  // Sold by only one shop — nothing to compare.
  await createShopProduct(a.id, curd.id, { onlinePricePaise: 9000, onlineStock: 10 });
  return { admin, a, b, c, milk };
}

describe("home price comparison", () => {
  it("is empty while switched off or without a location", async () => {
    const s = await scene();
    expect(await homePriceComparison(PUNE)).toEqual([]);
    await setRule("homePriceComparison", { enabled: true }, { id: s.admin.id, role: "ADMIN" });
    expect(await homePriceComparison(null)).toEqual([]);
  });

  it("lists a product's price at every nearby shop, cheapest first and highlighted, skipping empty-priced loose goods", async () => {
    const s = await scene();
    await setRule("homePriceComparison", { enabled: true }, { id: s.admin.id, role: "ADMIN" });
    const result = await homePriceComparison(PUNE);
    expect(result.map((p) => p.productName)).toEqual(["Cow Milk"]);
    const [milk] = result;
    expect(milk.prices.map((p) => [p.shopName, p.pricePaise, p.cheapest])).toEqual([
      ["Beta Dairy", 6800, true],
      ["Gamma Dairy", 7000, false],
      ["Alpha Dairy", 7200, false],
    ]);
    expect(milk.spreadPaise).toBe(400);
  });
});

describe("home price comparison ranking", () => {
  const day = 86_400_000;
  const live = () => ({ startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) });

  /**
   * Three shops, one price per shop (null: not sold there). Most widely sold
   * first, then the biggest saving, then name, gives Butter and Dal (tied, so
   * by name), Atta, then Cheese, Eggs, Flour — Ghee is seventh and Honey has
   * only one shop.
   */
  async function catalogue() {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const cat = await createCategory({ department: "DAIRY", name: "Grocery" });
    const shops = [
      await createShop(owner.id, { name: "Alpha Store" }),
      await createShop(owner.id, { name: "Beta Store" }),
      await createShop(owner.id, { name: "Gamma Store" }),
    ];
    const prices: Record<string, (number | null)[]> = {
      Atta: [1000, 1100, 1050],
      Butter: [1000, 1300, 1200],
      Dal: [1000, 1300, 1250],
      Cheese: [1000, 1800, null],
      Eggs: [1000, 1200, null],
      Flour: [1000, 1100, null],
      Ghee: [1000, 1050, null],
      Honey: [1000, null, null],
    };
    const listings: Record<string, string> = {};
    for (const [name, perShop] of Object.entries(prices)) {
      const product = await createProduct(cat.id, { name, unit: "kg" });
      for (const [i, price] of perShop.entries()) {
        if (price == null) continue;
        const sp = await createShopProduct(shops[i].id, product.id, { onlinePricePaise: price, onlineStock: 10 });
        listings[`${name}@${i}`] = sp.id;
      }
    }
    await setRule("homePriceComparison", { enabled: true }, { id: admin.id, role: "ADMIN" });
    return { admin, owner, shops, listings };
  }

  it("ranks by how many shops sell a product, then the biggest saving, then name, and keeps the top six", async () => {
    await catalogue();

    const result = await homePriceComparison(PUNE);
    expect(result.map((p) => [p.productName, p.prices.length, p.spreadPaise])).toEqual([
      ["Butter", 3, 300],
      ["Dal", 3, 300],
      ["Atta", 3, 100],
      ["Cheese", 2, 800],
      ["Eggs", 2, 200],
      ["Flour", 2, 100],
    ]);
    expect((await homePriceComparison(PUNE, { maxProducts: 2 })).map((p) => p.productName)).toEqual(["Butter", "Dal"]);
  });

  it("ranks by offer prices when a shop offer is live, as the cart would charge", async () => {
    const { admin, owner, shops, listings } = await catalogue();
    await setRule("shopOffers", { enabled: true }, { id: admin.id, role: "ADMIN" });
    const actor = { id: owner.id, role: "SHOP_OWNER" };
    // Half off Atta and Ghee at Alpha: Atta's saving becomes 600, and Ghee's
    // 550 lifts it from seventh into the list — past list-price ranking.
    for (const name of ["Atta", "Ghee"]) {
      await saveShopOffer(
        shops[0].id,
        { title: `${name} half price`, targetType: "PRODUCT", shopProductId: listings[`${name}@0`], discountType: "PERCENT", percent: 50, ...live() },
        actor,
      );
    }

    const result = await homePriceComparison(PUNE);
    expect(result.map((p) => [p.productName, p.spreadPaise])).toEqual([
      ["Atta", 600],
      ["Butter", 300],
      ["Dal", 300],
      ["Cheese", 800],
      ["Ghee", 550],
      ["Eggs", 200],
    ]);
    expect(result[0].prices[0]).toMatchObject({ shopName: "Alpha Store", pricePaise: 500, listPricePaise: 1000, cheapest: true });
  });
});
