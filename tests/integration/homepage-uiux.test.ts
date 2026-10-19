/**
 * docs/homepage-uiux-2026-10 — the product-discovery home page's services,
 * against the real database: search suggestions (F2), recent and trending
 * searches (F2), hero banners (F1), "Popular in your area" (F3) and the
 * per-product price comparison behind "Compare N prices" (F4).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { homeBanners, orderItems, platformSettings, searchQueries } from "@/server/db/schema";
import { createBanner, deleteBanner, listAllBanners, listLiveBanners, moveBanner, setBannerActive, updateBanner } from "@/server/services/home-banners";
import { nearbyOfferCounts, popularInArea } from "@/server/services/home-discovery";
import { homePriceComparison } from "@/server/services/price-comparison";
import { clearRecentSearches, listRecentSearches, listTrendingSearches, recordSearch, suggest } from "@/server/services/search-suggest";
import { serviceableShopIds } from "@/server/services/serviceability";
import { clearRuleCache } from "@/server/services/settings";
import { createCategory, createOrder, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

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
  await db.delete(homeBanners);
  await db.delete(searchQueries);
  await db.delete(platformSettings).where(eq(platformSettings.key, "homePriceComparison"));
  clearRuleCache();
});

async function scene() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const cowMilk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const buffalo = await createProduct(cat.id, { name: "Buffalo Milk", unit: "L" });
  const percent = await createProduct(cat.id, { name: "Paneer 50% Fat", unit: "kg" });
  const a = await createShop(owner.id, { name: "Alpha Dairy" });
  const b = await createShop(owner.id, { name: "Beta Milk Centre" });
  const spA = await createShopProduct(a.id, cowMilk.id, { onlinePricePaise: 7200 });
  const spB = await createShopProduct(b.id, cowMilk.id, { onlinePricePaise: 6800 });
  const spBuffalo = await createShopProduct(a.id, buffalo.id, { onlinePricePaise: 8000 });
  await createShopProduct(b.id, percent.id, { onlinePricePaise: 9000 });
  return { owner, cat, cowMilk, buffalo, percent, a, b, spA, spB, spBuffalo };
}

describe("search suggestions (F2)", () => {
  it("groups products, shops and categories, and ignores one-letter queries", async () => {
    await scene();
    expect(await suggest("m", { lang: "en" })).toMatchObject({ products: [], shops: [], categories: [] });
    const result = await suggest("milk", { lang: "en" });
    expect(result.products.map((p) => p.name)).toEqual(["Cow Milk", "Buffalo Milk"]);
    expect(result.products[0]).toMatchObject({ shopCount: 2, nearbyCount: 0, href: "/search?q=Cow%20Milk" });
    expect(result.shops.map((s) => s.name)).toEqual(["Beta Milk Centre"]);
    expect(result.categories.map((c) => c.label)).toContain("Milk");
  });

  it("puts products sold near the visitor first", async () => {
    const s = await scene();
    const nearby = new Map<string, number | null>([[s.a.id, 1.2]]);
    const result = await suggest("milk", { lang: "en", nearby });
    // Both are sold by Alpha (nearby); Cow Milk is also sold by Beta.
    expect(result.products.every((p) => p.nearbyCount === 1)).toBe(true);
    const shops = await suggest("dairy", { lang: "en", nearby });
    expect(shops.shops[0]).toMatchObject({ name: "Alpha Dairy", distanceKm: 1.2 });
  });

  it("matches LIKE wildcards literally", async () => {
    await scene();
    expect((await suggest("50%", { lang: "en" })).products.map((p) => p.name)).toEqual(["Paneer 50% Fat"]);
    expect((await suggest("%%", { lang: "en" })).products).toEqual([]);
  });

  it("finds categories by their Hindi and Marathi names", async () => {
    expect((await suggest("डेयरी", { lang: "hi" })).categories[0]).toMatchObject({ key: "dairy", label: "डेयरी", href: "/shops?type=DAIRY" });
    expect((await suggest("किराणा", { lang: "mr" })).categories[0]).toMatchObject({ key: "grocery" });
  });

  it("leaves out unapproved shops and inactive listings", async () => {
    const s = await scene();
    const pending = await createShop(s.owner.id, { name: "Milky Way Pending", status: "PENDING_APPROVAL" });
    await createShopProduct(pending.id, s.cowMilk.id, { onlinePricePaise: 5000 });
    const result = await suggest("milk", { lang: "en" });
    expect(result.shops.map((x) => x.name)).not.toContain("Milky Way Pending");
    expect(result.products.find((p) => p.name === "Cow Milk")?.shopCount).toBe(2);
  });
});

describe("recent and trending searches (F2)", () => {
  it("keeps a customer's own searches, newest first, and clears them", async () => {
    const user = await createUser();
    await recordSearch(user.id, "  Cow   MILK ");
    await recordSearch(user.id, "bread");
    await recordSearch(user.id, "cow milk");
    await recordSearch(user.id, "x"); // too short: not kept
    expect(await listRecentSearches(user.id)).toEqual(["cow milk", "bread"]);
    await clearRecentSearches(user.id);
    expect(await listRecentSearches(user.id)).toEqual([]);
  });

  it("trends what at least two searches asked for, topped up with the defaults in the visitor's language", async () => {
    const user = await createUser();
    await recordSearch(null, "ghee");
    await recordSearch(user.id, "ghee");
    await recordSearch(null, "honey");
    const trending = await listTrendingSearches("hi", 4);
    expect(trending[0]).toEqual({ q: "ghee", label: "ghee" });
    expect(trending.map((t) => t.q)).not.toContain("honey");
    expect(trending).toHaveLength(4);
    expect(trending[1]).toEqual({ q: "milk", label: "दूध" });
  });
});

describe("home hero banners (F1)", () => {
  it("only admins and operators manage banners; every change is checked", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const customer = await createUser();
    await expect(createBanner(customer, { title: "Nope", ctaHref: "/" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createBanner(admin, { title: "Bad link", ctaHref: "javascript:alert(1)" })).rejects.toThrow();
    await expect(createBanner(admin, { title: "Bad PIN", ctaHref: "/", pincode: "12" })).rejects.toThrow();
    await expect(
      createBanner(admin, { title: "Backwards", ctaHref: "/", startsAt: new Date("2026-10-20"), endsAt: new Date("2026-10-19") }),
    ).rejects.toThrow();
    const operator = await createUser({ role: "OPERATOR" });
    const ok = await createBanner(operator, { title: "Diwali sweets", ctaHref: "/shops?type=SWEET_SHOP", kind: "SEASONAL" });
    expect(ok).toMatchObject({ title: "Diwali sweets", active: true, kind: "SEASONAL" });
  });

  it("shows live banners in order, by schedule and targeting", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const now = new Date("2026-10-20T10:00:00Z");
    const everywhere = await createBanner(admin, { title: "Everywhere", ctaHref: "/" });
    await createBanner(admin, { title: "Future", ctaHref: "/", startsAt: new Date("2026-10-21T00:00:00Z") });
    await createBanner(admin, { title: "Ended", ctaHref: "/", startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-10-20T10:00:00Z") });
    const pin = await createBanner(admin, { title: "Kharadi only", ctaHref: "/", pincode: "411014" });
    await createBanner(admin, { title: "Mumbai only", ctaHref: "/", city: "Mumbai" });
    const off = await createBanner(admin, { title: "Switched off", ctaHref: "/" });
    await setBannerActive(admin, off.id, false);

    expect((await listLiveBanners({ pincode: null, cities: [] }, now)).map((b) => b.title)).toEqual(["Everywhere"]);
    expect((await listLiveBanners({ pincode: "411014", cities: ["pune"] }, now)).map((b) => b.title)).toEqual(["Everywhere", "Kharadi only"]);
    expect((await listLiveBanners({ pincode: "400001", cities: ["MUMBAI"] }, now)).map((b) => b.title)).toEqual(["Everywhere", "Mumbai only"]);

    // Past "Ended" and "Future" (not live, still in the order), then past "Everywhere".
    for (let i = 0; i < 3; i += 1) await moveBanner(admin, pin.id, "up");
    expect((await listLiveBanners({ pincode: "411014", cities: [] }, now)).map((b) => b.title)).toEqual(["Kharadi only", "Everywhere"]);

    await updateBanner(admin, everywhere.id, { title: "Everywhere, renamed", ctaHref: "/shops" });
    expect((await listAllBanners(admin)).find((b) => b.id === everywhere.id)).toMatchObject({ title: "Everywhere, renamed", ctaHref: "/shops" });
    await deleteBanner(admin, everywhere.id);
    expect((await listAllBanners(admin)).map((b) => b.title)).not.toContain("Everywhere, renamed");
  });
});

describe("popular in your area (F3) and Compare N prices (F4)", () => {
  it("ranks the most-ordered listings near the visitor, one card per product", async () => {
    const s = await scene();
    const customer = await createUser();
    for (const [sp, shop, times] of [
      [s.spBuffalo, s.a, 3],
      [s.spA, s.a, 1],
      [s.spB, s.b, 2],
    ] as const) {
      for (let i = 0; i < times; i += 1) {
        const order = await createOrder(customer.id, shop.id, { status: "DELIVERED" });
        await db.insert(orderItems).values({
          orderId: order.id,
          shopProductId: sp.id,
          productNameSnapshot: "x",
          unitSnapshot: "L",
          unitPricePaise: 7000,
          quantityMilli: 1000,
          lineTotalPaise: 7000,
        });
      }
    }
    const nearby = [...(await serviceableShopIds(PUNE)).keys()];
    expect(nearby.length).toBeGreaterThanOrEqual(2);
    const popular = await popularInArea(PUNE, { nearbyShopIds: nearby });
    expect(popular.scope).toBe("area");
    expect(popular.items.map((i) => [i.name, i.orders])).toEqual([
      ["Buffalo Milk", 3],
      ["Cow Milk", 2],
    ]);

    const counts = await nearbyOfferCounts([s.cowMilk.id, s.buffalo.id], nearby);
    expect(counts.get(s.cowMilk.id)).toBe(2);
    expect(counts.get(s.buffalo.id)).toBe(1);
  });

  it("falls back to products on sale when nothing has been ordered yet", async () => {
    await scene();
    const popular = await popularInArea(null);
    expect(popular.scope).toBe("catalogue");
    expect(popular.items.length).toBeGreaterThan(0);
    expect(new Set(popular.items.map((i) => i.productId)).size).toBe(popular.items.length);
  });

  it("compares one product's prices on request, whatever the home comparison rule says", async () => {
    const s = await scene();
    // Rule homePriceComparison is off by default: the general list stays empty...
    expect(await homePriceComparison(PUNE)).toEqual([]);
    // ...but "Compare N prices" for one product works.
    const [compared] = await homePriceComparison(PUNE, { productId: s.cowMilk.id, maxProducts: 1 });
    expect(compared.productName).toBe("Cow Milk");
    expect(compared.prices.map((p) => [p.shopName, p.pricePaise, p.cheapest])).toEqual([
      ["Beta Milk Centre", 6800, true],
      ["Alpha Dairy", 7200, false],
    ]);
    expect(compared.spreadPaise).toBe(400);
    // Sold by one shop only: nothing to compare.
    expect(await homePriceComparison(PUNE, { productId: s.buffalo.id })).toEqual([]);
  });
});
