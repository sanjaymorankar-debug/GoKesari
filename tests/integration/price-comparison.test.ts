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
