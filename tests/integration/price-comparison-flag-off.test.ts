/**
 * docs/price-comparison-off-2026-11 (owner decision 24-Nov-2026): with flag
 * `local_price_comparison_enabled` off (the seeded value), no comparison data
 * leaves the server — not the home block, not one product's prices (the
 * /search/compare?product= link), and no "Compare N prices" counts on cards.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { featureFlags, platformSettings } from "@/server/db/schema";
import { clearFeatureFlagCache, isFeatureEnabled } from "@/server/services/feature-flags";
import { nearbyOfferCounts } from "@/server/services/home-discovery";
import { homePriceComparison, isLocalPriceComparisonEnabled } from "@/server/services/price-comparison";
import { clearRuleCache } from "@/server/services/settings";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

const PUNE: CustomerLocation = { label: "PIN 411001", pincode: "411001", latitude: null, longitude: null, source: "PINCODE", addressId: null, societyId: null };

async function setFlag(enabled: boolean | null) {
  if (enabled === null) await db.delete(featureFlags).where(eq(featureFlags.key, "local_price_comparison_enabled"));
  else
    await db
      .insert(featureFlags)
      .values({ key: "local_price_comparison_enabled", enabled })
      .onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "homePriceComparison"));
  clearRuleCache();
});

async function twoShopsSellingMilk() {
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shopIds: string[] = [];
  for (const [name, price] of [["Shop A", 6000], ["Shop B", 5800]] as const) {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name });
    await createShopProduct(shop.id, milk.id, { onlinePricePaise: price, onlineStock: 10 });
    shopIds.push(shop.id);
  }
  return { milk, shopIds };
}

describe("local price comparison flag", () => {
  it("is off when the row is missing and when the seeded row says off", async () => {
    await setFlag(null);
    expect(await isLocalPriceComparisonEnabled()).toBe(false);
    await setFlag(false);
    expect(await isFeatureEnabled("local_price_comparison_enabled")).toBe(false);
  });

  it("off: no home block, no single-product prices, no card counts", async () => {
    const { milk, shopIds } = await twoShopsSellingMilk();
    await setFlag(false);
    expect(await homePriceComparison(PUNE)).toEqual([]);
    expect(await homePriceComparison(PUNE, { productId: milk.id, maxProducts: 1 })).toEqual([]);
    expect((await nearbyOfferCounts([milk.id], shopIds)).size).toBe(0);
  });

  it("on: the same data comes back", async () => {
    const { milk, shopIds } = await twoShopsSellingMilk();
    await setFlag(true);
    expect((await nearbyOfferCounts([milk.id], shopIds)).get(milk.id)).toBe(2);
    const [compared] = await homePriceComparison(PUNE, { productId: milk.id, maxProducts: 1 });
    expect(compared?.prices.length).toBe(2);
  });
});
