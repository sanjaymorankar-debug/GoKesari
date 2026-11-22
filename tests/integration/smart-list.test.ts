/**
 * Photo shopping list → wishlist → shop price comparison (docs/smart-shopping-2026-11, Feature 1).
 * The AI provider is mocked: no paid call is made. Everything else (matching, packs, stock, prices,
 * cart) runs against the real database.
 */
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { featureFlags, productLocalNames, shoppingListScanPages, shoppingListScans, smartWishlistItems } from "@/server/db/schema";
import { getCart } from "@/server/services/cart";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { scanShoppingList, sweepExpiredScanPhotos } from "@/server/services/smart-list/scan";
import { compareSavedWishlist, getWishlist, orderFromShop, saveWishlist } from "@/server/services/smart-list/wishlist";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

const aiAnswer = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/server/ai/provider", async (orig) => {
  const real = await orig<typeof import("@/server/ai/provider")>();
  return {
    ...real,
    runAi: vi.fn(async () => ({ output: aiAnswer.value, usage: { inputTokens: 1000, outputTokens: 200 }, model: "mock" })),
    activeAiProvider: vi.fn(async () => ({ provider: { name: "claude" }, model: "mock" })),
  };
});

const HERE: CustomerLocation = { label: "Home", pincode: "411001", latitude: 18.52, longitude: 73.85, source: "PINCODE", addressId: null, societyId: null };

async function flagOn() {
  await db.insert(featureFlags).values({ key: "smart_list_scan_enabled", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  clearFeatureFlagCache();
}

async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 600, channels: 3, background: "#fff" } }).png().toBuffer();
}

const line = (raw: string, item_en: string, item_local: string, quantity: number | null, unit: string | null, read_confidence = 92) => ({
  raw, language: "mr", item_en, item_local, brand: null, quantity, unit, read_confidence,
});

async function world() {
  const customer = await createUser();
  const grocery = await createCategory({ department: "GROCERY", name: "Staples" } as never);
  const sugar = await createProduct(grocery.id, { name: "Sugar 1 kg", unit: "kg", unitSizeMilli: 1000, subscribable: false });
  const sugarHalf = await createProduct(grocery.id, { name: "Sugar 500 g", unit: "g", unitSizeMilli: 500_000, subscribable: false });
  const milk = await createProduct(grocery.id, { name: "Cow Milk", unit: "L", unitSizeMilli: 1000, subscribable: false });
  const rice = await createProduct(grocery.id, { name: "Rice Loose", unit: "kg", unitSizeMilli: 1000, kind: "LOOSE", subscribable: false });
  await db.insert(productLocalNames).values([
    { productId: sugar.id, nameMr: "साखर", nameHi: "चीनी", searchText: "sugar साखर चीनी" },
    { productId: milk.id, nameMr: "दूध", nameHi: "दूध", searchText: "milk दूध" },
    { productId: rice.id, nameMr: "तांदूळ", nameHi: "चावल", searchText: "rice तांदूळ चावल" },
  ]);
  const ownerA = await createUser({ role: "SHOP_OWNER" });
  const ownerB = await createUser({ role: "SHOP_OWNER" });
  const shopA = await createShop(ownerA.id, { name: "Shop A", latitude: 18.521, longitude: 73.851, deliveryFeePaise: 2000 });
  const shopB = await createShop(ownerB.id, { name: "Shop B", latitude: 18.53, longitude: 73.86, deliveryFeePaise: 0 });
  // A: sugar 1 kg ₹45, milk ₹60 (only 1 left), loose rice without a price.
  const aSugar = await createShopProduct(shopA.id, sugar.id, { onlinePricePaise: 4500, onlineStock: 20 });
  await createShopProduct(shopA.id, milk.id, { onlinePricePaise: 6000, onlineStock: 1 });
  await createShopProduct(shopA.id, rice.id, { onlinePricePaise: null, onlineSaleEnabled: false, onlineStock: 50 });
  // B: sugar only in 500 g packs ₹24, milk ₹58.
  await createShopProduct(shopB.id, sugarHalf.id, { onlinePricePaise: 2400, onlineStock: 20 });
  await createShopProduct(shopB.id, milk.id, { onlinePricePaise: 5800, onlineStock: 30 });
  return { customer, sugar, milk, rice, shopA, shopB, aSugar };
}

beforeEach(async () => {
  await resetDatabase();
  await flagOn();
});

describe("scan", () => {
  it("reads a Marathi list, normalises quantities and matches the catalogue by local names", async () => {
    const { customer, sugar, milk } = await world();
    aiAnswer.value = {
      readable: true, unreadable_reason: null, handwritten: true, languages: ["mr"], is_bill: false,
      lines: [line("साखर १ किलो", "Sugar", "साखर", 1, "kg"), line("दूध २ लिटर", "Milk", "दूध", 2, "L"), line("अर्धा किलो तूप", "Ghee", "तूप", 0.5, "kg", 40)],
    };
    const res = await scanShoppingList(customer.id, [{ bytes: await photo(), contentType: "image/png" }], "mr");
    expect(res.status).toBe("READ");
    expect(res.lines.map((l) => [l.quantityAmount, l.quantityUnit])).toEqual([[1000, "g"], [2000, "ml"], [500, "g"]]);
    expect(res.lines[0].productId).toBe(sugar.id);
    expect(res.lines[1].productId).toBe(milk.id);
    // Ghee is not in the catalogue: no match, nothing silently substituted.
    expect(res.lines[2].productId).toBeNull();
    const [scan] = await db.select().from(shoppingListScans).where(eq(shoppingListScans.id, res.scanId));
    expect(scan).toMatchObject({ status: "READ", pageCount: 1, lineCount: 3 });
  });

  it("records an unreadable photo with the reason — never an empty wishlist", async () => {
    const { customer } = await world();
    aiAnswer.value = { readable: false, unreadable_reason: "BLURRY", handwritten: true, languages: [], is_bill: false, lines: [] };
    const res = await scanShoppingList(customer.id, [{ bytes: await photo(), contentType: "image/png" }], "en");
    expect(res).toMatchObject({ status: "UNREADABLE", unreadableReason: "BLURRY", lines: [] });
  });

  it("is refused while the feature flag is off", async () => {
    const { customer } = await world();
    await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "smart_list_scan_enabled"));
    clearFeatureFlagCache();
    await expect(scanShoppingList(customer.id, [{ bytes: await photo(), contentType: "image/png" }], "en")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes photos after the retention date and keeps the scan", async () => {
    const { customer } = await world();
    aiAnswer.value = { readable: true, unreadable_reason: null, handwritten: false, languages: ["en"], is_bill: false, lines: [line("Milk 2 L", "Milk", "Milk", 2, "L")] };
    const res = await scanShoppingList(customer.id, [{ bytes: await photo(), contentType: "image/png" }], "en");
    expect(await sweepExpiredScanPhotos(new Date(Date.now() + 31 * 86_400_000))).toBe(1);
    expect(await db.select().from(shoppingListScanPages).where(eq(shoppingListScanPages.scanId, res.scanId))).toHaveLength(0);
    const [scan] = await db.select().from(shoppingListScans).where(eq(shoppingListScans.id, res.scanId));
    expect(scan.photosDeletedAt).not.toBeNull();
  });
});

describe("compare and order", () => {
  async function savedList() {
    const w = await world();
    const { id } = await saveWishlist(w.customer.id, {
      name: "Weekly",
      items: [
        { nameEn: "Sugar", nameLocal: "साखर", productId: w.sugar.id, aiProductId: w.sugar.id, matchConfidence: 90, quantityAmount: 2000, quantityUnit: "g" },
        { nameEn: "Milk", nameLocal: "दूध", productId: w.milk.id, aiProductId: w.milk.id, matchConfidence: 90, quantityAmount: 2000, quantityUnit: "ml" },
        { nameEn: "Rice", nameLocal: "तांदूळ", productId: w.rice.id, aiProductId: null, matchConfidence: null, quantityAmount: 5000, quantityUnit: "g" },
      ],
    });
    return { ...w, id };
  }

  it("prices a virtual cart per shop: pack conversion, stock, price on confirmation, delivery options", async () => {
    const { customer, id, shopA, shopB } = await savedList();
    const cmp = await compareSavedWishlist(customer.id, id, HERE);
    const a = cmp.shops.find((s) => s.shopId === shopA.id)!;
    const b = cmp.shops.find((s) => s.shopId === shopB.id)!;
    // A: 2 × 1 kg sugar = ₹90; milk needs 2 L, only 1 left → missing; rice has no price → on confirmation.
    expect(a.items.map((q) => q.status)).toEqual(["AVAILABLE", "LOW_STOCK", "PRICE_ON_CONFIRMATION"]);
    expect(a.itemsPaise).toBe(9000);
    expect(a.priceOnConfirmation).toBe(1);
    expect(a.available).toBe(2);
    // B: sugar as a similar product, 4 × 500 g = ₹96; milk 2 × ₹58; no rice.
    expect(b.items.map((q) => q.status)).toEqual(["SIMILAR", "AVAILABLE", "MISSING"]);
    expect(b.items[0]).toMatchObject({ cartQuantity: 4, linePaise: 9600 });
    expect(b.itemsPaise).toBe(9600 + 11_600);
    expect(a.deliveryOptions.map((o) => o.key)).toContain("PICKUP");
    expect(a.deliveryOptions.find((o) => o.key !== "PICKUP")?.feePaise).toBe(2000);
  });

  it("orders from one shop: available items to the cart, the rest marked not ordered, changes reported", async () => {
    const { customer, id, shopB } = await savedList();
    const cmp = await compareSavedWishlist(customer.id, id, HERE);
    const b = cmp.shops.find((s) => s.shopId === shopB.id)!;
    const seen = Object.fromEntries(b.items.map((q) => [q.itemId, q.linePaise]));
    seen[b.items[1].itemId] = 10_000; // the customer saw ₹100 for milk; it is ₹116 now
    const res = await orderFromShop(customer.id, id, shopB.id, HERE, seen);
    expect(res.added).toHaveLength(2);
    expect(res.notAdded.map((n) => n.reason)).toEqual(["Not sold by this shop"]);
    expect(res.changes).toEqual([expect.objectContaining({ before: 10_000, now: 11_600, note: "Price went up" })]);
    const cart = await getCart(customer.id);
    expect(cart.groups).toHaveLength(1);
    expect(cart.groups[0].lines.map((l) => l.quantity).sort()).toEqual([2, 4]);
    const list = await getWishlist(customer.id, id);
    expect(list.items.map((i) => i.status)).toEqual(["IN_CART", "IN_CART", "NOT_ORDERED"]);
    // The not-ordered item can be compared again on its own.
    const again = await compareSavedWishlist(customer.id, id, HERE, true);
    expect(again.itemIds).toHaveLength(1);
  });

  it("another customer's wishlist is not found", async () => {
    const { id } = await savedList();
    const other = await createUser();
    await expect(getWishlist(other.id, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(compareSavedWishlist(other.id, id, HERE)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records user edits against the AI match for accuracy", async () => {
    const { customer, id, sugar } = await savedList();
    const items = await db.select().from(smartWishlistItems).where(eq(smartWishlistItems.wishlistId, id));
    expect(items.find((i) => i.productId === sugar.id)?.userEdited).toBe(false);
    expect(items.find((i) => i.nameEn === "Rice")?.userEdited).toBe(true);
    void customer;
  });
});
