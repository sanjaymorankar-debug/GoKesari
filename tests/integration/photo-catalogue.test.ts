/**
 * Shop photo catalogue (/shop/catalogue): every listing with the photo
 * customers see and its prices, and the two things a tile does — attach or
 * change a photo, set a price — through the real routes and checks.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

// Only the session source is mocked; authorization and ownership run for real.
vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as addPhotoRoute } from "@/app/api/products/[id]/images/route";
import { PATCH as photoRoute } from "@/app/api/products/[id]/images/[imageId]/route";
import { PATCH as listingRoute } from "@/app/api/shop-products/[id]/route";
import { buildPricePatch, needsPhoto, needsPrice } from "@/lib/photo-catalogue";
import { db } from "@/server/db";
import { platformSettings, products, shopProductCategories, shopProducts, storedImages } from "@/server/db/schema";
import { addImage, listShopPhotoCatalogue } from "@/server/services/product-images";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "imageModeration"));
  clearRuleCache();
});

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

/** A stored upload, as POST /api/images would leave it. */
async function upload(ownerId: string) {
  const [img] = await db
    .insert(storedImages)
    .values({
      ownerId,
      purpose: "PRODUCT",
      contentType: "image/png",
      sizeBytes: 4,
      width: 1,
      height: 1,
      sha256: Math.random().toString(16).slice(2),
      data: Buffer.from([1, 2, 3, 4]),
    })
    .returning();
  return img.id;
}

async function scene() {
  const ownerUser = await createUser({ role: "SHOP_OWNER" });
  const owner = { id: ownerUser.id, role: "SHOP_OWNER" as const };
  const shop = await createShop(ownerUser.id);
  const milk = await createCategory({ department: "DAIRY", name: "Milk" });
  const bread = await createCategory({ department: "BAKERY", name: "Bread" });

  const plain = await createProduct(milk.id, { name: "Buffalo Milk", unit: "L" });
  const catalogued = await createProduct(milk.id, { name: "Cow Milk", unit: "L" });
  await db.update(products).set({ imageUrl: "https://img.example/cow-milk.jpg" }).where(eq(products.id, catalogued.id));
  const loaf = await createProduct(bread.id, { name: "Brown Bread", unit: "piece" });

  const plainListing = await createShopProduct(shop.id, plain.id, { onlinePricePaise: 8000 });
  const cataloguedListing = await createShopProduct(shop.id, catalogued.id, {
    onlinePricePaise: 7000,
    offlineSaleEnabled: true,
    offlinePricePaise: 6500,
  });
  const loafListing = await createShopProduct(shop.id, loaf.id, {
    onlineSaleEnabled: false,
    onlinePricePaise: null,
    offlineSaleEnabled: false,
    offlinePricePaise: null,
  });
  return { ownerUser, owner, shop, milk, bread, plain, catalogued, loaf, plainListing, cataloguedListing, loafListing };
}

const tileOf = async (shopId: string, shopProductId: string) =>
  (await listShopPhotoCatalogue(shopId)).find((t) => t.shopProductId === shopProductId)!;

describe("listShopPhotoCatalogue", () => {
  it("shows each listing with the photo customers see and its prices", async () => {
    const s = await scene();
    const tiles = await listShopPhotoCatalogue(s.shop.id);
    expect(tiles.map((t) => t.productName).sort()).toEqual(["Brown Bread", "Buffalo Milk", "Cow Milk"]);

    const plain = tiles.find((t) => t.shopProductId === s.plainListing.id)!;
    expect(plain).toMatchObject({ liveImageUrl: null, liveImageSource: null, ownPrimary: null, ownPhotoCount: 0 });
    expect(needsPhoto(plain)).toBe(true);

    const catalogued = tiles.find((t) => t.shopProductId === s.cataloguedListing.id)!;
    expect(catalogued).toMatchObject({
      liveImageUrl: "https://img.example/cow-milk.jpg",
      liveImageSource: "PRODUCT",
      onlinePricePaise: 7000,
      offlinePricePaise: 6500,
      unit: "L",
      categoryName: "Milk",
    });
    expect(needsPhoto(catalogued)).toBe(false);

    const loaf = tiles.find((t) => t.shopProductId === s.loafListing.id)!;
    expect(needsPrice(loaf)).toBe(true);
    expect(needsPrice(catalogued)).toBe(false);
  });

  it("prefers the shop's own photo over the catalogue photo, and leaves out other shops and removed listings", async () => {
    const s = await scene();
    const own = await addImage(
      { productId: s.catalogued.id, shopProductId: s.cataloguedListing.id, storedImageId: await upload(s.owner.id) },
      s.owner,
    );

    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const otherShop = await createShop(otherOwner.id, { name: "Other Dairy" });
    const otherListing = await createShopProduct(otherShop.id, s.catalogued.id);
    await addImage(
      { productId: s.catalogued.id, shopProductId: otherListing.id, storedImageId: await upload(otherOwner.id) },
      { id: otherOwner.id, role: "SHOP_OWNER" },
    );
    await db.update(shopProducts).set({ deletedAt: new Date() }).where(eq(shopProducts.id, s.plainListing.id));

    const tiles = await listShopPhotoCatalogue(s.shop.id);
    expect(tiles.map((t) => t.shopProductId).sort()).toEqual([s.cataloguedListing.id, s.loafListing.id].sort());
    const tile = tiles.find((t) => t.shopProductId === s.cataloguedListing.id)!;
    expect(tile).toMatchObject({
      liveImageUrl: own.url,
      liveImageSource: "LISTING",
      ownPrimary: { id: own.id, url: own.url, moderationStatus: "APPROVED" },
      ownPhotoCount: 1,
      pendingCount: 0,
    });
  });

  it("shows the owner a photo awaiting review while customers still see the catalogue photo", async () => {
    const s = await scene();
    const admin = await createUser({ role: "ADMIN" });
    await setRule("imageModeration", { enabled: true }, { id: admin.id, role: "ADMIN" });
    const pending = await addImage(
      { productId: s.catalogued.id, shopProductId: s.cataloguedListing.id, storedImageId: await upload(s.owner.id) },
      s.owner,
    );

    const tile = await tileOf(s.shop.id, s.cataloguedListing.id);
    expect(tile).toMatchObject({
      liveImageUrl: "https://img.example/cow-milk.jpg",
      liveImageSource: "PRODUCT",
      ownPrimary: { id: pending.id, moderationStatus: "PENDING" },
      pendingCount: 1,
    });

    // A product with no photo anywhere but one waiting for review does not "need a photo".
    await addImage({ productId: s.plain.id, shopProductId: s.plainListing.id, storedImageId: await upload(s.owner.id) }, s.owner);
    const plain = await tileOf(s.shop.id, s.plainListing.id);
    expect(plain.liveImageUrl).toBeNull();
    expect(needsPhoto(plain)).toBe(false);
  });

  it("marks a listing paused when the shop stops carrying its category", async () => {
    const s = await scene();
    await db
      .delete(shopProductCategories)
      .where(and(eq(shopProductCategories.shopId, s.shop.id), eq(shopProductCategories.categoryId, s.bread.id)));
    expect((await tileOf(s.shop.id, s.loafListing.id)).paused).toBe(true);
    expect((await tileOf(s.shop.id, s.plainListing.id)).paused).toBe(false);
  });
});

describe("photo catalogue tile actions (routes)", () => {
  it("adds a first photo to a listing, then changes it", async () => {
    const s = await scene();
    signInAs(s.ownerUser);

    const added = await call(addPhotoRoute, `/api/products/${s.plain.id}/images`, {
      method: "POST",
      params: { id: s.plain.id },
      body: { storedImageId: await upload(s.owner.id), shopProductId: s.plainListing.id },
    });
    expect(added.status).toBe(201);
    let tile = await tileOf(s.shop.id, s.plainListing.id);
    expect(tile).toMatchObject({ liveImageUrl: added.body.url, liveImageSource: "LISTING", ownPhotoCount: 1 });
    expect(tile.ownPrimary?.id).toBe(added.body.id);

    const changed = await call(photoRoute, `/api/products/${s.plain.id}/images/${added.body.id}`, {
      method: "PATCH",
      params: { id: s.plain.id, imageId: added.body.id },
      body: { action: "replace", storedImageId: await upload(s.owner.id) },
    });
    expect(changed.status).toBe(200);
    tile = await tileOf(s.shop.id, s.plainListing.id);
    expect(tile.liveImageUrl).toBe(changed.body.url);
    expect(tile.liveImageUrl).not.toBe(added.body.url);
    expect(tile.ownPhotoCount).toBe(1);
  });

  it("does not let another shop's owner put a photo on this listing", async () => {
    const s = await scene();
    const intruder = await createUser({ role: "SHOP_OWNER" });
    await createShop(intruder.id, { name: "Intruder Dairy" });
    signInAs(intruder);
    const res = await call(addPhotoRoute, `/api/products/${s.plain.id}/images`, {
      method: "POST",
      params: { id: s.plain.id },
      body: { storedImageId: await upload(intruder.id), shopProductId: s.plainListing.id },
    });
    expect(res.status).toBe(403);
    expect((await tileOf(s.shop.id, s.plainListing.id)).ownPhotoCount).toBe(0);
  });

  it("sets a first price on an unpriced listing and puts it on sale on that channel", async () => {
    const s = await scene();
    signInAs(s.ownerUser);
    const before = await tileOf(s.shop.id, s.loafListing.id);
    const built = buildPricePatch(before, { online: "45", offline: "" });
    if ("error" in built) throw new Error(built.error);

    const res = await call(listingRoute, `/api/shop-products/${s.loafListing.id}`, {
      method: "PATCH",
      params: { id: s.loafListing.id },
      body: built.patch,
    });
    expect(res.status).toBe(200);
    const after = await tileOf(s.shop.id, s.loafListing.id);
    expect(after).toMatchObject({ onlinePricePaise: 4500, onlineSaleEnabled: true, offlinePricePaise: null, offlineSaleEnabled: false });
    expect(needsPrice(after)).toBe(false);
  });

  it("changes only the price that was edited", async () => {
    const s = await scene();
    signInAs(s.ownerUser);
    const before = await tileOf(s.shop.id, s.cataloguedListing.id);
    const built = buildPricePatch(before, { online: "72.50", offline: "65" });
    if ("error" in built) throw new Error(built.error);
    expect(built.patch).toEqual({ onlinePricePaise: 7250 });

    const res = await call(listingRoute, `/api/shop-products/${s.cataloguedListing.id}`, {
      method: "PATCH",
      params: { id: s.cataloguedListing.id },
      body: built.patch,
    });
    expect(res.status).toBe(200);
    expect(await tileOf(s.shop.id, s.cataloguedListing.id)).toMatchObject({ onlinePricePaise: 7250, offlinePricePaise: 6500 });
  });
});
