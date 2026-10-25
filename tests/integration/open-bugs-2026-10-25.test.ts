/**
 * The open bugs from the 21 Oct status report (GAP-011, GAP-014, GAP-016, GAP-019).
 * GAP-012, GAP-017 and GAP-018 are screen changes, checked in the browser (PR notes).
 * Real PostgreSQL; runs on one database and on the split layout.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const nav = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/server/auth", () => ({
  auth: async () => nav.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import OrdersPage from "@/app/orders/page";
import { db } from "@/server/db";
import { platformSettings, shopProducts } from "@/server/db/schema";
import { searchProductsForMapping } from "@/server/integrations/connections";
import { autoMatch } from "@/server/integrations/pull";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { searchShops } from "@/server/services/shops";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
  nav.session = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function dairySellingMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED", name: "Sharma Stores" });
  const category = await createCategory({ department: "DAIRY", name: "Fresh Dairy" });
  const milk = await createProduct(category.id, { name: "Toned Milk 500ml", unit: "pc" });
  const listing = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 3_000, onlineStock: 10 });
  return { shop, listing, category };
}

describe("GAP-011: search finds the shops that sell a product", () => {
  it("finds a shop by a product it sells and by the product's category", async () => {
    const { shop } = await dairySellingMilk();
    expect((await searchShops({ query: "milk" })).map((s) => s.id)).toEqual([shop.id]);
    expect((await searchShops({ query: "fresh dairy" })).map((s) => s.id)).toEqual([shop.id]);
    expect(await searchShops({ query: "paneer" })).toEqual([]);
  });

  it("does not find a shop whose listing is removed, inactive, or outside the categories it carries", async () => {
    const { listing } = await dairySellingMilk();
    await db.update(shopProducts).set({ isActive: false }).where(eq(shopProducts.id, listing.id));
    expect(await searchShops({ query: "milk" })).toEqual([]);
    await db.update(shopProducts).set({ isActive: true, deletedAt: new Date() }).where(eq(shopProducts.id, listing.id));
    expect(await searchShops({ query: "milk" })).toEqual([]);
  });

  it("does not find an unapproved shop", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "New Stores" });
    const category = await createCategory({ department: "DAIRY", name: "Fresh Dairy" });
    const milk = await createProduct(category.id, { name: "Cow Milk 1L", unit: "pc" });
    await createShopProduct(shop.id, milk.id, { onlinePricePaise: 6_000, onlineStock: 5 });
    expect(await searchShops({ query: "milk" })).toEqual([]);
  });
});

describe("GAP-016: the integrations 'listed' flag", () => {
  it("marks the shop's own products when mapping, and only those", async () => {
    const { shop } = await dairySellingMilk();
    const other = await createProduct((await createCategory({ department: "DAIRY", name: "Milk Others" })).id, { name: "Buffalo Milk 1L", unit: "pc" });
    const rows = await searchProductsForMapping(shop.id, "milk");
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.listed]));
    expect(byName["Toned Milk 500ml"]).toBe(true);
    expect(byName[other.name]).toBe(false);
    // The shop's own product comes first.
    expect(rows[0].name).toBe("Toned Milk 500ml");
  });

  it("matches an item by name only among the shop's own products", async () => {
    const { shop, listing } = await dairySellingMilk();
    const match = await autoMatch(shop.id, { name: "Toned Milk 500ml" } as Parameters<typeof autoMatch>[1]);
    expect(match).toMatchObject({ status: "MATCHED", method: "NAME", productId: listing.productId });

    const owner = await createUser({ role: "SHOP_OWNER" });
    const otherShop = await createShop(owner.id, { status: "APPROVED", name: "Other Stores" });
    const suggested = await autoMatch(otherShop.id, { name: "Toned Milk 500ml" } as Parameters<typeof autoMatch>[1]);
    expect(suggested.status).toBe("SUGGESTED");
  });
});

describe("GAP-014: /orders?tab=returns", () => {
  it("opens the Returns page, and My lists for tab=lists", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    nav.session = { user: { id: customer.id, email: customer.email, name: null, image: null, role: "CUSTOMER", status: "ACTIVE" } };
    await expect(OrdersPage({ searchParams: Promise.resolve({ tab: "returns" }) })).rejects.toThrow("REDIRECT /returns");
    await expect(OrdersPage({ searchParams: Promise.resolve({ tab: "lists" }) })).rejects.toThrow("REDIRECT /lists");
  });
});

describe("GAP-019: business rules are read in one query", () => {
  it("reads every rule with one query on a cold cache, then serves them from memory", async () => {
    const select = vi.spyOn(db, "select");
    await Promise.all([getRule("shopWallet"), getRule("deliverySlots"), getRule("shopAcceptance"), getRule("notifications")]);
    await getRule("deliveryOtp");
    await getRule("riskRules");
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("still returns stored overrides, and a saved change at once", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await db.insert(platformSettings).values({ key: "invoicing", value: { enabled: true, defaultGstRateBp: 500 }, updatedBy: admin.id });
    expect((await getRule("invoicing")).defaultGstRateBp).toBe(500);
    await setRule("invoicing", { enabled: true, defaultGstRateBp: 1200 }, { id: admin.id, role: "ADMIN" });
    expect((await getRule("invoicing")).defaultGstRateBp).toBe(1200);
  });
});
