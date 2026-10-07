/**
 * F10 — product image moderation: shop owners' photos wait for approval
 * before customers see them; staff uploads and existing photos stay live.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { platformSettings, productImages, products, shopProducts, storedImages } from "@/server/db/schema";
import {
  addImage,
  galleryFor,
  isHiddenProductFile,
  listImages,
  listPendingImages,
  moderateImage,
  replaceImage,
} from "@/server/services/product-images";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "imageModeration"));
  clearRuleCache();
});

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
  const admin = await createUser({ role: "ADMIN" });
  const ownerUser = await createUser({ role: "SHOP_OWNER" });
  const owner = { id: ownerUser.id, role: "SHOP_OWNER" as const };
  const staff = { id: admin.id, role: "ADMIN" as const };
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(ownerUser.id);
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 5 });
  return { admin, owner, staff, product, sp };
}

const listingUrl = async (spId: string) => (await db.select().from(shopProducts).where(eq(shopProducts.id, spId)))[0].imageUrl;

describe("image moderation", () => {
  it("is off by default: an owner's photo goes live at once (unchanged)", async () => {
    const s = await scene();
    const img = await addImage({ productId: s.product.id, shopProductId: s.sp.id, storedImageId: await upload(s.owner.id) }, s.owner);
    expect(img.moderationStatus).toBe("APPROVED");
    expect(await listingUrl(s.sp.id)).toBe(img.url);
  });

  it("holds an owner's photo until approved, then shows it", async () => {
    const s = await scene();
    await setRule("imageModeration", { enabled: true }, s.staff);
    const fileId = await upload(s.owner.id);
    const img = await addImage({ productId: s.product.id, shopProductId: s.sp.id, storedImageId: fileId }, s.owner);
    expect(img.moderationStatus).toBe("PENDING");
    expect(await listingUrl(s.sp.id)).toBeNull();
    expect(await galleryFor(s.product.id, s.sp.id)).toHaveLength(0);
    expect(await listImages(s.product.id, s.sp.id)).toHaveLength(1); // the owner still sees it
    expect(await isHiddenProductFile(fileId)).toBe(true);
    expect((await listPendingImages()).map((p) => p.id)).toEqual([img.id]);

    await moderateImage(img.id, { decision: "approve" }, s.staff);
    expect(await listingUrl(s.sp.id)).toBe(img.url);
    expect(await galleryFor(s.product.id, s.sp.id)).toHaveLength(1);
    expect(await isHiddenProductFile(fileId)).toBe(false);
  });

  it("rejects with a reason and never shows the photo; a reason is required", async () => {
    const s = await scene();
    await setRule("imageModeration", { enabled: true }, s.staff);
    const img = await addImage({ productId: s.product.id, shopProductId: s.sp.id, storedImageId: await upload(s.owner.id) }, s.owner);
    await expect(moderateImage(img.id, { decision: "reject" }, s.staff)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(moderateImage(img.id, { decision: "approve" }, s.owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rejected = await moderateImage(img.id, { decision: "reject", reason: "Blurry photo" }, s.staff);
    expect(rejected).toMatchObject({ moderationStatus: "REJECTED", rejectionReason: "Blurry photo" });
    expect(await listingUrl(s.sp.id)).toBeNull();
    await expect(moderateImage(img.id, { decision: "approve" }, s.staff)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps an already-live photo live while its replacement waits, and lets staff uploads straight through", async () => {
    const s = await scene();
    const live = await addImage({ productId: s.product.id, shopProductId: s.sp.id, storedImageId: await upload(s.owner.id) }, s.owner);
    await setRule("imageModeration", { enabled: true }, s.staff);
    const second = await addImage({ productId: s.product.id, shopProductId: s.sp.id, storedImageId: await upload(s.owner.id) }, s.owner);
    expect(second.moderationStatus).toBe("PENDING");
    expect(await listingUrl(s.sp.id)).toBe(live.url); // existing photo stays live

    const replaced = await replaceImage(s.product.id, live.id, await upload(s.owner.id), s.owner);
    expect(replaced.moderationStatus).toBe("PENDING");
    expect(await listingUrl(s.sp.id)).toBeNull();

    const staffImg = await addImage({ productId: s.product.id, storedImageId: await upload(s.admin.id) }, s.staff);
    expect(staffImg.moderationStatus).toBe("APPROVED");
    const [p] = await db.select().from(products).where(eq(products.id, s.product.id));
    expect(p.imageUrl).toBe(staffImg.url);
    expect(await db.select().from(productImages)).toHaveLength(3);
  });
});
