/**
 * Product search on the storefront (/search): every typed word must match the
 * product, its category, the shop, the shop owner or the area, in any order;
 * a word that is a PIN code matches the shop's PIN. Cards carry the owner's
 * name, shown first on the card.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
});

async function twoShops() {
  const milk = await createCategory({ name: "Milk" });
  const cow = await createProduct(milk.id, { name: "Cow Milk" });
  const badam = await createProduct(milk.id, { name: "Badam Milk" });
  const ownerA = await createUser({ role: "SHOP_OWNER" });
  const ownerB = await createUser({ role: "SHOP_OWNER" });
  const agtci = await createShop(ownerA.id, { name: "Agtci" });
  const asmy = await createShop(ownerB.id, { name: "Asmy Exports" });
  await db.update(shops).set({ ownerName: "Sanjay Morankar" }).where(eq(shops.id, agtci.id));
  await db.update(shops).set({ ownerName: "Ravi Patil", pincode: "411038" }).where(eq(shops.id, asmy.id));
  for (const shop of [agtci, asmy]) {
    await createShopProduct(shop.id, cow.id);
    await createShopProduct(shop.id, badam.id);
  }
  return { agtci, asmy };
}

const names = (rows: Awaited<ReturnType<typeof listStorefrontProducts>>) =>
  rows.map((r) => `${r.productName} @ ${r.shopName}`).sort();

describe("storefront product search", () => {
  it("carries the shop owner's name on every result", async () => {
    await twoShops();
    const rows = await listStorefrontProducts({ query: "badam" });
    expect(rows.map((r) => [r.shopName, r.shopOwnerName]).sort()).toEqual([
      ["Agtci", "Sanjay Morankar"],
      ["Asmy Exports", "Ravi Patil"],
    ]);
  });

  it("finds a shop's products by the owner's name", async () => {
    await twoShops();
    expect(names(await listStorefrontProducts({ query: "morankar" }))).toEqual(["Badam Milk @ Agtci", "Cow Milk @ Agtci"]);
  });

  it("needs every word to match, in any order and across fields", async () => {
    await twoShops();
    expect(names(await listStorefrontProducts({ query: "badam milk agtci" }))).toEqual(["Badam Milk @ Agtci"]);
    expect(names(await listStorefrontProducts({ query: "  ravi   cow " }))).toEqual(["Cow Milk @ Asmy Exports"]);
    expect(await listStorefrontProducts({ query: "badam nowhere" })).toEqual([]);
  });

  it("matches a PIN code typed with other words", async () => {
    await twoShops();
    expect(names(await listStorefrontProducts({ query: "cow 411038" }))).toEqual(["Cow Milk @ Asmy Exports"]);
  });
});
