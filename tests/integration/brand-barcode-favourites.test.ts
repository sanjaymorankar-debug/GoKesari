/**
 * Brand search, barcode search and favourites (docs/search-brand-barcode-favourites-2026-11; flag
 * brand_barcode_favourites_enabled): the services, the routes, and the flag-OFF behaviour (everything
 * as before; the new routes answer 404).
 */
import { eq } from "drizzle-orm";
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

import { GET as detailsRoute } from "@/app/api/favourites/details/route";
import { DELETE as favDeleteRoute, GET as favGetRoute, POST as favPostRoute } from "@/app/api/favourites/route";
import { GET as barcodeRoute } from "@/app/api/products/barcode/route";
import { GET as suggestRoute } from "@/app/api/search/suggest/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { brands, favourites, featureFlags, products, shopProducts } from "@/server/db/schema";
import { getPublicBrandBySlug, searchPublicBrands } from "@/server/services/brands";
import { findProductByBarcode } from "@/server/services/barcode-lookup";
import { listStorefrontProducts, lowestOffersForProducts } from "@/server/services/catalogue";
import { addFavourite, describeFavourites, listFavouriteIds, MAX_FAVOURITES, mergeFavourites, removeFavourite } from "@/server/services/favourites";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { searchProductsByBarcode } from "@/server/services/product-barcode-search";
import { suggest } from "@/server/services/search-suggest";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

const FLAG = "brand_barcode_favourites_enabled" as const;

async function setFlag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: FLAG, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
});

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

/** Amul butter and Amul ghee (brand Amul, EAN-13s), plain sugar (no brand), sold by two shops. */
async function catalogue() {
  const dairy = await createCategory({ name: "Dairy" });
  const [amul] = await db.insert(brands).values({ name: "Amul", slug: "amul" }).returning();
  const butter = await createProduct(dairy.id, { name: "Butter 500 g" });
  const ghee = await createProduct(dairy.id, { name: "Pure Ghee 1 L" });
  const sugar = await createProduct(dairy.id, { name: "Sugar 1 kg" });
  await db.update(products).set({ brandId: amul.id, gtin: "8901063010017", mrpPaise: 29000, netQuantity: 500, netQuantityUnit: "g" }).where(eq(products.id, butter.id));
  await db.update(products).set({ brandId: amul.id, gtin: "8901063020016" }).where(eq(products.id, ghee.id));
  const a = await createShop((await createUser({ role: "SHOP_OWNER" })).id, { name: "Agtci Dairy" });
  const b = await createShop((await createUser({ role: "SHOP_OWNER" })).id, { name: "Asmy Stores" });
  await createShopProduct(a.id, butter.id, { onlinePricePaise: 28000 });
  await createShopProduct(b.id, butter.id, { onlinePricePaise: 27500 });
  await createShopProduct(a.id, ghee.id, { onlinePricePaise: 60000 });
  await createShopProduct(a.id, sugar.id, { onlinePricePaise: 4500 });
  return { amul, butter, ghee, sugar, a, b };
}

describe("brand search", () => {
  it("matches the brand name only when asked (flag on)", async () => {
    await catalogue();
    expect(await listStorefrontProducts({ query: "amul" })).toEqual([]);
    const rows = await listStorefrontProducts({ query: "amul", matchBrands: true });
    expect(new Set(rows.map((r) => r.productName))).toEqual(new Set(["Butter 500 g", "Pure Ghee 1 L"]));
    // Words still all have to match: "amul ghee" is the ghee only.
    expect((await listStorefrontProducts({ query: "amul ghee", matchBrands: true })).map((r) => r.productName)).toEqual(["Pure Ghee 1 L"]);
  });

  it("filters by brand, and ignores an inactive brand's name", async () => {
    const { amul } = await catalogue();
    expect((await listStorefrontProducts({ brandId: amul.id })).length).toBe(3);
    await db.update(brands).set({ isActive: false }).where(eq(brands.id, amul.id));
    expect(await listStorefrontProducts({ query: "amul", matchBrands: true })).toEqual([]);
    expect(await getPublicBrandBySlug("amul")).toBeNull();
  });

  it("finds brands for the search box and the brand page", async () => {
    await catalogue();
    expect((await searchPublicBrands("amu")).map((b) => [b.slug, b.productCount])).toEqual([["amul", 2]]);
    expect(await searchPublicBrands("a")).toEqual([]);
    expect((await getPublicBrandBySlug("AMUL"))?.name).toBe("Amul");
    expect(await getPublicBrandBySlug("../etc")).toBeNull();
  });

  it("adds a brands group to suggestions only when asked", async () => {
    await catalogue();
    const off = await suggest("amul", { lang: "en" });
    expect(off).not.toHaveProperty("brands");
    const on = await suggest("amul", { lang: "en", brands: true });
    expect(on.brands).toEqual([{ slug: "amul", name: "Amul", productCount: 2, href: "/brand/amul" }]);
  });

  it("the suggest route adds brands only while the flag is on", async () => {
    await catalogue();
    const off = await call(suggestRoute, "/api/search/suggest?q=amul");
    expect(off.status).toBe(200);
    expect(off.body).not.toHaveProperty("brands");
    await setFlag(true);
    const on = await call(suggestRoute, "/api/search/suggest?q=amul");
    expect(on.body.brands.map((b: { slug: string }) => b.slug)).toEqual(["amul"]);
  });
});

describe("barcode search", () => {
  it("finds the product with name, brand, pack size, MRP and shop count", async () => {
    const { butter } = await catalogue();
    const r = await searchProductsByBarcode("8901063010017");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([
      expect.objectContaining({ productId: butter.id, name: "Butter 500 g", brandName: "Amul", brandSlug: "amul", packSize: "500 g", mrpPaise: 29000, shopCount: 2, nearby: null }),
    ]);
  });

  it("matches the same item scanned as GTIN-14 and reports nearby prices", async () => {
    const { butter, b } = await catalogue();
    const r = await searchProductsByBarcode("08901063010017", { nearbyShopIds: [b.id] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.matches[0]).toMatchObject({ productId: butter.id, nearby: { shopCount: 1, lowestPricePaise: 27500, buyable: true } });
  });

  it("returns every product sharing a code", async () => {
    const { ghee, sugar } = await catalogue();
    await db.update(products).set({ barcode: "8901063020016" }).where(eq(products.id, sugar.id));
    const r = await searchProductsByBarcode("8901063020016");
    if (!r.ok) throw new Error("expected ok");
    expect(r.matches.map((m) => m.productId)).toEqual([ghee.id, sugar.id]);
  });

  it("rejects an invalid check digit and hides unapproved products", async () => {
    const { butter } = await catalogue();
    expect(await searchProductsByBarcode("8901063010018")).toMatchObject({ ok: false, reason: "CHECK_DIGIT" });
    await db.update(products).set({ approvalStatus: "PENDING_APPROVAL" }).where(eq(products.id, butter.id));
    expect(await searchProductsByBarcode("8901063010017")).toMatchObject({ ok: true, matches: [] });
  });

  it("the route: 404 while the flag is off, 422 for a bad code, rate-limited", async () => {
    await catalogue();
    expect((await call(barcodeRoute, "/api/products/barcode?code=8901063010017")).status).toBe(404);
    await setFlag(true);
    const okRes = await call(barcodeRoute, "/api/products/barcode?code=8901063010017");
    expect(okRes.status).toBe(200);
    expect(okRes.body.matches).toHaveLength(1);
    const bad = await call(barcodeRoute, "/api/products/barcode?code=8901063010018");
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reason).toBe("CHECK_DIGIT");
    for (let i = 0; i < 30; i++) await call(barcodeRoute, "/api/products/barcode?code=96385074");
    expect((await call(barcodeRoute, "/api/products/barcode?code=96385074")).status).toBe(429);
  });

  it("the shop owner's lookup still works and now flags a mistyped GTIN", async () => {
    const { a, butter } = await catalogue();
    expect(await findProductByBarcode(a.id, "8901063010017")).toMatchObject({ match: { productId: butter.id, listed: true } });
    expect(await findProductByBarcode(a.id, "8901063010017")).not.toHaveProperty("invalidCheckDigit");
    expect(await findProductByBarcode(a.id, "8901063010018")).toMatchObject({ match: null, invalidCheckDigit: true });
    expect(await findProductByBarcode(a.id, "ABC12345")).toEqual({ code: "ABC12345", match: null });
  });
});

describe("favourites", () => {
  it("adds, lists, removes; adding twice changes nothing", async () => {
    const { butter, ghee } = await catalogue();
    const user = await createUser();
    expect(await addFavourite(user.id, butter.id)).toEqual({ added: true });
    expect(await addFavourite(user.id, butter.id)).toEqual({ added: false });
    await addFavourite(user.id, ghee.id);
    expect(new Set(await listFavouriteIds(user.id))).toEqual(new Set([butter.id, ghee.id]));
    expect(await removeFavourite(user.id, butter.id)).toEqual({ removed: true });
    expect(await removeFavourite(user.id, butter.id)).toEqual({ removed: false });
    expect(await listFavouriteIds(user.id)).toEqual([ghee.id]);
  });

  it("refuses an unknown or unapproved product (no foreign key: the service checks)", async () => {
    const { butter } = await catalogue();
    const user = await createUser();
    await expect(addFavourite(user.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.update(products).set({ approvalStatus: "PENDING_APPROVAL" }).where(eq(products.id, butter.id));
    await expect(addFavourite(user.id, butter.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stops at the limit", async () => {
    const { butter } = await catalogue();
    const user = await createUser();
    await db.insert(favourites).values(
      Array.from({ length: MAX_FAVOURITES }, (_, i) => ({ userId: user.id, productId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })),
    );
    await expect(addFavourite(user.id, butter.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("merges a guest's hearts: skips junk, unknown and already-saved ids", async () => {
    const { butter, ghee, sugar } = await catalogue();
    const user = await createUser();
    await addFavourite(user.id, butter.id);
    const result = await mergeFavourites(user.id, [butter.id, ghee.id, sugar.id.toUpperCase(), "not-a-uuid", 42, "00000000-0000-4000-8000-000000000000"]);
    expect(result.added).toBe(2);
    expect(new Set(result.ids)).toEqual(new Set([butter.id, ghee.id, sugar.id]));
  });

  it("describes favourites with the lowest buyable price, near the customer when given", async () => {
    const { butter, ghee, a, b } = await catalogue();
    const user = await createUser();
    await addFavourite(user.id, butter.id);
    await addFavourite(user.id, ghee.id);
    const all = await describeFavourites({ userId: user.id });
    const butterView = all.find((v) => v.productId === butter.id)!;
    expect(butterView).toMatchObject({ brandName: "Amul", packSize: "500 g", gone: false, nearby: false, best: { onlinePricePaise: 27500, shopName: "Asmy Stores", buyable: true, shopCount: 2 } });
    // Near shop A only: A's price, and ghee there too.
    const near = await describeFavourites({ userId: user.id }, { shopIds: [a.id] });
    expect(near.find((v) => v.productId === butter.id)?.best).toMatchObject({ onlinePricePaise: 28000, shopCount: 1 });
    // Near shop B only: no ghee there.
    const nearB = await describeFavourites({ userId: user.id }, { shopIds: [b.id] });
    expect(nearB.find((v) => v.productId === ghee.id)?.best).toBeNull();
    // Out of stock at B: A's listing becomes the best buyable one.
    await db.update(shopProducts).set({ isAvailable: false }).where(eq(shopProducts.shopId, b.id));
    const offers = await lowestOffersForProducts([butter.id]);
    expect(offers.get(butter.id)).toMatchObject({ onlinePricePaise: 28000, buyable: true });
  });

  it("shows a removed product as gone, and drops a guest's unknown ids", async () => {
    const { butter } = await catalogue();
    const user = await createUser();
    await addFavourite(user.id, butter.id);
    await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, butter.id));
    expect(await describeFavourites({ userId: user.id })).toMatchObject([{ productId: butter.id, gone: true, best: null }]);
    expect(await describeFavourites({ productIds: ["00000000-0000-4000-8000-000000000000", "junk"] })).toEqual([]);
  });

  it("the routes: 404 while the flag is off, sign-in required, add / merge / remove", async () => {
    const { butter, ghee } = await catalogue();
    const user = await createUser();
    signInAs(user);
    expect((await call(favGetRoute, "/api/favourites")).status).toBe(404);
    expect((await call(favPostRoute, "/api/favourites", { method: "POST", body: { productId: butter.id } })).status).toBe(404);
    expect((await call(detailsRoute, `/api/favourites/details?ids=${butter.id}`)).status).toBe(404);
    expect(await listFavouriteIds(user.id)).toEqual([]);

    await setFlag(true);
    state.session = null;
    expect((await call(favGetRoute, "/api/favourites")).status).toBe(401);
    const guest = await call(detailsRoute, `/api/favourites/details?ids=${butter.id},${ghee.id}`);
    expect(guest.status).toBe(200);
    expect(guest.body.items.map((i: { productId: string }) => i.productId)).toEqual([butter.id, ghee.id]);

    signInAs(user);
    const added = await call(favPostRoute, "/api/favourites", { method: "POST", body: { productId: butter.id } });
    expect(added).toMatchObject({ status: 200, body: { added: true, ids: [butter.id] } });
    const merged = await call(favPostRoute, "/api/favourites", { method: "POST", body: { productIds: [ghee.id, butter.id] } });
    expect(merged.body.added).toBe(1);
    const details = await call(favGetRoute, "/api/favourites?details=1");
    expect(details.body.items).toHaveLength(2);
    const removed = await call(favDeleteRoute, `/api/favourites?productId=${butter.id}`, { method: "DELETE" });
    expect(removed.body).toEqual({ removed: true, ids: [ghee.id] });
    expect((await call(favPostRoute, "/api/favourites", { method: "POST", body: { productId: "nope" } })).status).toBe(422);
  });

  it("another customer's favourites are never touched", async () => {
    const { butter } = await catalogue();
    const one = await createUser();
    const two = await createUser();
    await addFavourite(one.id, butter.id);
    await setFlag(true);
    signInAs(two);
    expect((await call(favGetRoute, "/api/favourites")).body.ids).toEqual([]);
    await call(favDeleteRoute, `/api/favourites?productId=${butter.id}`, { method: "DELETE" });
    expect(await listFavouriteIds(one.id)).toEqual([butter.id]);
  });
});
