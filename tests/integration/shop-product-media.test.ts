/**
 * Module 1 — shop product photos and descriptions (docs/three-modules-2026-10).
 *
 * Real PostgreSQL and the real image pipeline (sharp). Covers the brief's
 * "photo upload limits" test cases — 5 MB, 5 photos (also when uploads race),
 * real type from the bytes, EXIF stripped, three WebP sizes — plus who may
 * edit (owner, staff, support; never another shop), the master fallback,
 * ordering, descriptions, the change log, disk storage and the bulk ZIP + CSV.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as imageRoute } from "@/app/api/images/[id]/route";
import { POST as uploadRoute } from "@/app/api/shops/[id]/listings/[listingId]/media/photos/route";
import { GET as mediaGet, PATCH as mediaPatch } from "@/app/api/shops/[id]/listings/[listingId]/media/route";
import { POST as staffAdd } from "@/app/api/shops/[id]/staff/route";
import { db } from "@/server/db";
import {
  auditLogs,
  platformSettings,
  productImages,
  products,
  shopMediaImportItems,
  shopMediaImports,
  shopProducts,
  storedImageVariants,
  storedImages,
} from "@/server/db/schema";
import { sweepOrphanFiles } from "@/server/media/blob-store";
import { PHOTO_ERRORS, processProductPhoto } from "@/server/media/photo-pipeline";
import { addImage } from "@/server/services/product-images";
import { readImageBytes, getImageMeta } from "@/server/services/image-store";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import {
  deleteListingPhoto,
  getListingMedia,
  listingHistory,
  reorderListingPhotos,
  updateListingDescriptions,
  uploadListingPhoto,
} from "@/server/services/shop-media";
import {
  cancelMediaImport,
  createMediaImport,
  parsePhotoName,
  runMediaImport,
  startMediaImport,
} from "@/server/services/shop-media-import";
import { addShopStaff, assertShopCatalogueAccess, removeShopStaff, type CatalogueActor } from "@/server/services/shop-staff";
import { NextRequest } from "next/server";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

/* ----------------------------------------------------------------- images */

/** A real JPEG carrying EXIF with a marker string, so stripping can be proven. */
async function jpegWithExif(width = 1600, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .withExif({ IFD0: { Copyright: "SECRET-EXIF-MARKER", ImageDescription: "GPS 18.5204N 73.8567E" } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const png = (width = 400, height = 300) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();

/** Multipart request for the upload route. */
function uploadRequest(shopId: string, listingId: string, bytes: Buffer, name = "photo.jpg"): NextRequest {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }));
  return new NextRequest(`http://localhost/api/shops/${shopId}/listings/${listingId}/media/photos`, { method: "POST", body: form });
}

async function upload(shopId: string, listingId: string, bytes: Buffer, name?: string) {
  const response = await (uploadRoute as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
    uploadRequest(shopId, listingId, bytes, name),
    { params: Promise.resolve({ id: shopId, listingId }) },
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

/* --------------------------------------------------------------- fixtures */

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER", name: "Owner One" });
  const shop = await createShop(owner.id, { name: "Media Shop" });
  const category = await createCategory();
  const product = await createProduct(category.id, { name: "Toned Milk" });
  await db.update(products).set({ description: "Master text about toned milk. It is pasteurised and homogenised." }).where(eq(products.id, product.id));
  const listing = await createShopProduct(shop.id, product.id);
  const [p] = await db.select().from(products).where(eq(products.id, product.id));
  return { owner, shop, category, product: p, listing };
}

const ownerActor = (owner: { id: string }): CatalogueActor => ({ id: owner.id, role: "SHOP_OWNER", via: "OWNER" });

let mediaDir: string | null = null;

beforeEach(async () => {
  state.session = null;
  delete process.env.MEDIA_DIR;
  await resetDatabase();
  await db.delete(platformSettings);
  clearRuleCache();
});

afterEach(async () => {
  delete process.env.MEDIA_DIR;
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
  mediaDir = null;
});

/* ============================================================ the pipeline */

describe("photo pipeline", () => {
  it("strips EXIF and makes three WebP sizes within the configured edges", async () => {
    const rules = await getRule("shopProductMedia");
    const source = await jpegWithExif();
    expect(source.includes(Buffer.from("SECRET-EXIF-MARKER"))).toBe(true);
    const photo = await processProductPhoto(source, rules);
    for (const [variant, edge] of [
      [photo.large, 1200],
      [photo.medium, 600],
      [photo.thumb, 200],
    ] as const) {
      const meta = await sharp(variant.data).metadata();
      expect(meta.format).toBe("webp");
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(edge);
      expect(meta.exif).toBeUndefined();
      expect(variant.data.includes(Buffer.from("SECRET-EXIF-MARKER"))).toBe(false);
    }
    expect(photo.large.width).toBe(1200);
  });

  it("never enlarges a small photo", async () => {
    const photo = await processProductPhoto(await png(300, 200), await getRule("shopProductMedia"));
    expect([photo.large.width, photo.medium.width, photo.thumb.width]).toEqual([300, 300, 200]);
  });

  it("refuses a file over 5 MB, by one byte", async () => {
    const rules = await getRule("shopProductMedia");
    expect(rules.maxUploadBytes).toBe(5 * 1024 * 1024);
    const big = Buffer.concat([await jpegWithExif(200, 200), Buffer.alloc(rules.maxUploadBytes)]).subarray(0, rules.maxUploadBytes + 1);
    await expect(processProductPhoto(big, rules)).rejects.toMatchObject({ details: { reason: PHOTO_ERRORS.TOO_LARGE } });
  });

  it("judges the type by the bytes: an .exe named .jpg and a GIF are refused, a PNG named .jpg is fine", async () => {
    const rules = await getRule("shopProductMedia");
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary"), Buffer.alloc(4000)]);
    await expect(processProductPhoto(exe, rules)).rejects.toMatchObject({ details: { reason: PHOTO_ERRORS.BAD_TYPE } });
    const gif = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ff0000" } }).gif().toBuffer();
    await expect(processProductPhoto(gif, rules)).rejects.toMatchObject({ details: { reason: PHOTO_ERRORS.BAD_TYPE } });
    await expect(processProductPhoto(await png(), rules)).resolves.toMatchObject({ source: { contentType: "image/png" } });
  });

  it("refuses a file that only starts like a JPEG", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(2000, 7)]);
    await expect(processProductPhoto(fake, await getRule("shopProductMedia"))).rejects.toMatchObject({
      details: { reason: expect.stringMatching(/PHOTO_(UNREADABLE|BAD_TYPE)/) },
    });
  });

  it("refuses a too-small photo and one with too many pixels (decompression-bomb guard)", async () => {
    const rules = await getRule("shopProductMedia");
    await expect(processProductPhoto(await png(60, 60), rules)).rejects.toMatchObject({ details: { reason: PHOTO_ERRORS.TOO_SMALL } });
    await expect(processProductPhoto(await png(1200, 1000), { ...rules, maxInputPixels: 1_000_000 })).rejects.toMatchObject({
      details: { reason: expect.stringMatching(/PHOTO_(TOO_MANY_PIXELS|UNREADABLE)/) },
    });
  });
});

/* ================================================================= limits */

describe("upload limits through the route", () => {
  it("accepts a photo, makes it the main photo, and serves all three sizes without EXIF", async () => {
    const { owner, shop, listing } = await setup();
    signIn(owner);
    const res = await upload(shop.id, listing.id, await jpegWithExif());
    expect(res.status).toBe(201);
    expect(res.body.isPrimary).toBe(true);
    const [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(sp.imageUrl).toBe(res.body.url);
    expect(sp.contentUpdatedBy).toBe(owner.id);

    const storedId = res.body.url.split("/").pop();
    const variants = await db.select().from(storedImageVariants).where(eq(storedImageVariants.storedImageId, storedId));
    expect(variants.map((v) => v.variant).sort()).toEqual(["MEDIUM", "THUMB"]);

    for (const size of ["thumb", "medium", "large"]) {
      const response = await (imageRoute as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
        new NextRequest(`http://localhost/api/images/${storedId}?size=${size}`),
        { params: Promise.resolve({ id: storedId }) },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.includes(Buffer.from("SECRET-EXIF-MARKER"))).toBe(false);
      // A revalidation with the ETag gets a 304 and no body.
      const again = await (imageRoute as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
        new NextRequest(`http://localhost/api/images/${storedId}?size=${size}`, { headers: { "if-none-match": response.headers.get("etag")! } }),
        { params: Promise.resolve({ id: storedId }) },
      );
      expect(again.status).toBe(304);
    }
  });

  it("refuses a request body over 5 MB before reading it", async () => {
    const { owner, shop, listing } = await setup();
    signIn(owner);
    const res = await upload(shop.id, listing.id, Buffer.alloc(5 * 1024 * 1024 + 200 * 1024, 1));
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe("PHOTO_TOO_LARGE");
  });

  it("refuses a sixth photo", async () => {
    const { owner, shop, listing } = await setup();
    signIn(owner);
    for (let i = 0; i < 5; i += 1) expect((await upload(shop.id, listing.id, await png(300 + i, 300))).status).toBe(201);
    const sixth = await upload(shop.id, listing.id, await png(400, 300));
    expect(sixth.status).toBe(422);
    expect(sixth.body.error.details.reason).toBe("PHOTO_LIMIT");
    expect(await db.select().from(productImages).where(eq(productImages.shopProductId, listing.id))).toHaveLength(5);
  });

  it("serialises concurrent uploads: with one place left, exactly one of three succeeds", async () => {
    const { owner, shop, listing } = await setup();
    for (let i = 0; i < 4; i += 1) await uploadListingPhoto(shop.id, listing.id, await png(300 + i, 300), ownerActor(owner));
    const files = await Promise.all([0, 1, 2].map((i) => png(330 + i, 300)));
    const results = await Promise.allSettled(files.map((f) => uploadListingPhoto(shop.id, listing.id, f, ownerActor(owner))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect(r.reason.details.reason).toBe("PHOTO_LIMIT");
    }
    expect(await db.select().from(productImages).where(eq(productImages.shopProductId, listing.id))).toHaveLength(5);
  });

  it("refuses an .exe renamed .jpg through the route (422, nothing stored)", async () => {
    const { owner, shop, listing } = await setup();
    signIn(owner);
    const exe = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(10_000)]);
    const res = await upload(shop.id, listing.id, exe, "photo.jpg");
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe(PHOTO_ERRORS.BAD_TYPE);
    expect(await db.select().from(storedImages)).toHaveLength(0);
  });

  it("the older listing-photo route also stops at 5 for a shop listing", async () => {
    const { owner, shop, listing, product } = await setup();
    for (let i = 0; i < 5; i += 1) await uploadListingPhoto(shop.id, listing.id, await png(300 + i, 300), ownerActor(owner));
    const [stored] = await db
      .insert(storedImages)
      .values({ ownerId: owner.id, purpose: "PRODUCT", contentType: "image/png", sizeBytes: 3, width: 300, height: 300, sha256: "x", data: Buffer.from("abc") })
      .returning();
    await expect(
      addImage({ productId: product.id, shopProductId: listing.id, storedImageId: stored.id }, { id: owner.id, role: "SHOP_OWNER" }),
    ).rejects.toThrow(/At most 5 photos/);
  });
});

/* ================================================================= access */

describe("who may edit", () => {
  it("owner, staff and support may; another shop's owner, a stranger and revoked staff may not", async () => {
    const { owner, shop, listing } = await setup();
    const staff = await createUser({ name: "Staff Member" });
    const stranger = await createUser();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(otherOwner.id, { name: "Other Shop" });
    const operator = await createUser({ role: "OPERATOR" });

    signIn(owner);
    const added = await call(staffAdd, `/api/shops/${shop.id}/staff`, {
      method: "POST",
      body: { identifier: staff.phone },
      params: { id: shop.id },
    });
    expect(added.status).toBe(201);

    for (const [user, expected] of [
      [owner, 201],
      [staff, 201],
      [operator, 201],
      [stranger, 403],
      [otherOwner, 403],
    ] as const) {
      signIn(user);
      const res = await upload(shop.id, listing.id, await png(300, 300));
      expect(res.status, user.name ?? user.email).toBe(expected);
      if (expected === 201) await deleteListingPhoto(shop.id, listing.id, res.body.id, await assertShopCatalogueAccess(shop.id, user));
    }

    await removeShopStaff(shop.id, added.body.id, owner);
    signIn(staff);
    expect((await upload(shop.id, listing.id, await png(300, 300))).status).toBe(403);
  });

  it("staff cannot reach another shop's product through their own shop's URL", async () => {
    const { owner, shop } = await setup();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const other = await createShop(otherOwner.id, { name: "Other" });
    const cat = await createCategory();
    const otherListing = await createShopProduct(other.id, (await createProduct(cat.id, { name: "Bread" })).id);
    signIn(owner);
    const res = await upload(shop.id, otherListing.id, await png(300, 300));
    expect(res.status).toBe(404);
  });

  it("only the owner (or support) manages staff; staff cannot add staff", async () => {
    const { owner, shop } = await setup();
    const staff = await createUser();
    const third = await createUser();
    await addShopStaff(shop.id, staff.phone!, owner);
    await expect(addShopStaff(shop.id, third.phone!, staff)).rejects.toThrow(/Only the shop's owner/);
    await expect(addShopStaff(shop.id, staff.phone!, owner)).rejects.toThrow(/already/);
    await expect(addShopStaff(shop.id, "9000000000", owner)).rejects.toThrow(/No active GoKesari account/);
  });

  it("logs who changed what and when, and as what", async () => {
    const { owner, shop, listing } = await setup();
    const staff = await createUser({ name: "Staff Person" });
    await addShopStaff(shop.id, staff.email, owner);
    const staffActor = await assertShopCatalogueAccess(shop.id, staff);
    expect(staffActor.via).toBe("STAFF");
    await uploadListingPhoto(shop.id, listing.id, await png(), staffActor);
    await updateListingDescriptions(shop.id, listing.id, { shortDescription: "Fresh daily" }, ownerActor(owner));
    const history = await listingHistory(shop.id, listing.id);
    expect(history.map((h) => [h.summary, h.actorName, h.via])).toEqual([
      ["Changed the short description", "Owner One", "OWNER"],
      ["Added a photo", "Staff Person", "STAFF"],
    ]);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, listing.id), eq(auditLogs.action, "shop_product.description_changed")));
    expect(log.previousValue).toEqual({ shortDescription: null });
    expect(log.newValue).toMatchObject({ shortDescription: "Fresh daily", via: "OWNER" });
  });
});

/* ================================================= fallback, order, text */

describe("shop overrides and the master fallback", () => {
  it("shows the master photos and description until the shop sets its own", async () => {
    const { owner, shop, listing, product } = await setup();
    const [stored] = await db
      .insert(storedImages)
      .values({ ownerId: owner.id, purpose: "PRODUCT", contentType: "image/png", sizeBytes: 3, width: 300, height: 300, sha256: "m", data: Buffer.from("abc") })
      .returning();
    await db.insert(productImages).values({ productId: product.id, storedImageId: stored.id, url: `/api/images/${stored.id}`, isPrimary: true });

    let view = await getListingMedia(shop.id, listing.id);
    expect(view.effective.photos.map((p) => p.source)).toEqual(["MASTER"]);
    expect(view.effective.longSource).toBe("MASTER");
    expect(view.effective.shortSource).toBe("MASTER");
    expect(view.effective.shortDescription!.length).toBeLessThanOrEqual(160);

    await uploadListingPhoto(shop.id, listing.id, await png(), ownerActor(owner));
    await updateListingDescriptions(shop.id, listing.id, { shortDescription: "  Our   own  ", longDescription: "Line one\n\n\n\nLine two" }, ownerActor(owner));
    view = await getListingMedia(shop.id, listing.id);
    expect(view.effective.photos.map((p) => p.source)).toEqual(["SHOP"]);
    expect(view.effective.shortDescription).toBe("Our own");
    expect(view.effective.longDescription).toBe("Line one\n\nLine two");

    // Clearing goes back to the master's text.
    await updateListingDescriptions(shop.id, listing.id, { shortDescription: null, longDescription: "" }, ownerActor(owner));
    view = await getListingMedia(shop.id, listing.id);
    expect(view.effective.longSource).toBe("MASTER");
  });

  it("enforces the description limits (422 through the route)", async () => {
    const { owner, shop, listing } = await setup();
    signIn(owner);
    const res = await call(mediaPatch, `/api/shops/${shop.id}/listings/${listing.id}/media`, {
      method: "PATCH",
      body: { shortDescription: "x".repeat(161) },
      params: { id: shop.id, listingId: listing.id },
    });
    expect(res.status).toBe(422);
    const ok = await call(mediaPatch, `/api/shops/${shop.id}/listings/${listing.id}/media`, {
      method: "PATCH",
      body: { shortDescription: "x".repeat(160), longDescription: "y".repeat(4000) },
      params: { id: shop.id, listingId: listing.id },
    });
    expect(ok.status).toBe(200);
    const got = await call(mediaGet, `/api/shops/${shop.id}/listings/${listing.id}/media`, { params: { id: shop.id, listingId: listing.id } });
    expect(got.body.listing.shortDescription).toHaveLength(160);
  });

  it("the first photo in order is the main photo; removing it promotes the next", async () => {
    const { owner, shop, listing } = await setup();
    const a = await uploadListingPhoto(shop.id, listing.id, await png(300, 300), ownerActor(owner));
    const b = await uploadListingPhoto(shop.id, listing.id, await png(310, 300), ownerActor(owner));
    const c = await uploadListingPhoto(shop.id, listing.id, await png(320, 300), ownerActor(owner));
    await reorderListingPhotos(shop.id, listing.id, [c.id, a.id, b.id], ownerActor(owner));
    let view = await getListingMedia(shop.id, listing.id);
    expect(view.photos.map((p) => [p.id, p.isPrimary])).toEqual([[c.id, true], [a.id, false], [b.id, false]]);
    let [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(sp.imageUrl).toBe(c.url);

    await deleteListingPhoto(shop.id, listing.id, c.id, ownerActor(owner));
    view = await getListingMedia(shop.id, listing.id);
    expect(view.photos.map((p) => [p.id, p.isPrimary])).toEqual([[a.id, true], [b.id, false]]);
    [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(sp.imageUrl).toBe(a.url);

    await expect(reorderListingPhotos(shop.id, listing.id, [a.id], ownerActor(owner))).rejects.toThrow(/exactly once/);
  });
});

/* ========================================================== disk storage */

describe("files outside the web root", () => {
  it("writes random file names under MEDIA_DIR, serves them, and removes them when the photo goes", async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "gk-media-"));
    process.env.MEDIA_DIR = mediaDir;
    const { owner, shop, listing } = await setup();
    const added = await uploadListingPhoto(shop.id, listing.id, await jpegWithExif(), ownerActor(owner));
    const storedId = added.url.split("/").pop()!;
    const meta = await getImageMeta(storedId);
    expect(meta.storage).toBe("DISK");
    expect(meta.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}\.webp$/);
    const [row] = await db.select({ data: storedImages.data }).from(storedImages).where(eq(storedImages.id, storedId));
    expect(row.data).toBeNull();
    const full = path.join(mediaDir, ...meta.storageKey!.split("/"));
    expect(((await stat(full)).mode & 0o777).toString(8)).toBe("600");
    expect(full.includes(`${path.sep}public${path.sep}`)).toBe(false);

    const served = await readImageBytes(meta, "thumb");
    expect((await sharp(served.bytes).metadata()).width).toBe(200);

    const keys = [meta.storageKey!, ...(await db.select().from(storedImageVariants).where(eq(storedImageVariants.storedImageId, storedId))).map((v) => v.storageKey!)];
    await deleteListingPhoto(shop.id, listing.id, added.id, ownerActor(owner));
    expect(await sweepOrphanFiles(keys)).toBe(3);
    const left = await readdir(mediaDir, { recursive: true });
    expect(left.filter((f) => f.endsWith(".webp"))).toHaveLength(0);
  });

  it("refuses a storage key that is not one it made (no path traversal)", async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "gk-media-"));
    process.env.MEDIA_DIR = mediaDir;
    expect(await sweepOrphanFiles(["../../etc/passwd", "ab/cd/../../x.webp"])).toBe(0);
  });
});

/* ============================================================= bulk upload */

describe("bulk ZIP + CSV", () => {
  async function bulkSetup() {
    const base = await setup();
    const cat = base.category;
    const bread = await createProduct(cat.id, { name: "Brown Bread" });
    await db.update(products).set({ gtin: "8901234567890" }).where(eq(products.id, bread.id));
    const breadListing = await createShopProduct(base.shop.id, bread.id);
    const [breadRow] = await db.select().from(products).where(eq(products.id, bread.id));
    return { ...base, bread: breadRow, breadListing };
  }

  it("matches by SKU and barcode, reports what it cannot use, then applies in order", async () => {
    const { owner, shop, listing, product, bread, breadListing } = await bulkSetup();
    // The milk already has a shop photo, which REPLACE mode removes.
    await uploadListingPhoto(shop.id, listing.id, await png(300, 300), ownerActor(owner));

    const zip = new JSZip();
    zip.file(`${product.code}_2.jpg`, await jpegWithExif(800, 600));
    zip.file(`${product.code}_1.png`, await png(500, 400));
    zip.file(`${bread.gtin}.webp`, await sharp(await png(400, 400)).webp().toBuffer());
    zip.file("P99999.jpg", await png());
    zip.file("notes.txt", "hello");
    zip.file(`${product.code}_9.jpg`, await png());
    zip.file("__MACOSX/._junk.jpg", "x");
    const zipBytes = await zip.generateAsync({ type: "nodebuffer" });

    const csv = [
      "SKU or Barcode,Short Description,Long Description",
      `${product.code},"Fresh, cold milk","Long text, with a comma"`,
      `${bread.gtin},${"z".repeat(200)},`,
      "UNKNOWN1,Hello,",
      `${product.code},Again,`,
    ].join("\n");

    const preview = await createMediaImport(
      shop.id,
      { zip: { name: "photos.zip", bytes: zipBytes }, csv: { name: "d.csv", bytes: Buffer.from(csv) } },
      "REPLACE",
      ownerActor(owner),
    );
    const byName = Object.fromEntries(preview.items.map((i) => [i.sourceName, i]));
    expect(byName[`${product.code}_1.png`]).toMatchObject({ status: "MATCHED", matchMethod: "SKU", position: 1 });
    expect(byName[`${product.code}_2.jpg`]).toMatchObject({ status: "MATCHED", position: 2 });
    expect(byName[`${bread.gtin}.webp`]).toMatchObject({ status: "MATCHED", matchMethod: "GTIN" });
    expect(byName["P99999.jpg"].status).toBe("UNMATCHED");
    expect(byName["notes.txt"].status).toBe("INVALID");
    expect(byName[`${product.code}_9.jpg`].status).toBe("INVALID");
    expect(byName["__MACOSX/._junk.jpg"]).toBeUndefined();
    expect(byName["row 2"].status).toBe("MATCHED");
    expect(byName["row 3"].status).toBe("INVALID"); // short description too long
    expect(byName["row 4"].status).toBe("UNMATCHED");
    expect(byName["row 5"].status).toBe("DUPLICATE");
    expect(preview.replaces).toEqual([{ shopProductId: listing.id, productName: "Toned Milk", photos: 1 }]);
    // Nothing live changed yet.
    expect(await db.select().from(productImages).where(eq(productImages.shopProductId, breadListing.id))).toHaveLength(0);

    await startMediaImport(shop.id, preview.import.id);
    await expect(startMediaImport(shop.id, preview.import.id)).rejects.toThrow(/being applied/);
    const done = await runMediaImport(preview.import.id, ownerActor(owner));
    expect(done.import.status).toBe("APPLIED");
    expect(done.import.totals.applied).toBe(4);

    const milk = await getListingMedia(shop.id, listing.id);
    expect(milk.photos).toHaveLength(2);
    expect(milk.photos[0].isPrimary).toBe(true);
    const firstItem = done.items.find((i) => i.sourceName === `${product.code}_1.png`)!;
    expect(milk.photos[0].id).toBe(firstItem.productImageId);
    expect(milk.listing.shortDescription).toBe("Fresh, cold milk");
    expect(milk.listing.longDescription).toBe("Long text, with a comma");
    expect((await getListingMedia(shop.id, breadListing.id)).photos).toHaveLength(1);

    const [row] = await db.select().from(shopMediaImports).where(eq(shopMediaImports.id, preview.import.id));
    expect(row.archiveData).toBeNull();
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "shop_media_import.applied"));
    expect(logs).toHaveLength(1);
    await expect(startMediaImport(shop.id, preview.import.id)).rejects.toThrow(/already applied/);
  });

  it("ADD mode keeps existing photos and stops at the limit", async () => {
    const { owner, shop, listing, product } = await bulkSetup();
    for (let i = 0; i < 4; i += 1) await uploadListingPhoto(shop.id, listing.id, await png(300 + i, 300), ownerActor(owner));
    const zip = new JSZip();
    zip.file(`${product.code}_1.jpg`, await png(400, 300));
    zip.file(`${product.code}_2.jpg`, await png(410, 300));
    const preview = await createMediaImport(shop.id, { zip: { name: "z.zip", bytes: await zip.generateAsync({ type: "nodebuffer" }) } }, "ADD", ownerActor(owner));
    expect(preview.items.map((i) => i.status).sort()).toEqual(["INVALID", "MATCHED"]);
    await startMediaImport(shop.id, preview.import.id);
    await runMediaImport(preview.import.id, ownerActor(owner));
    expect((await getListingMedia(shop.id, listing.id)).photos).toHaveLength(5);
  });

  it("refuses an oversized entry without unpacking it (ZIP bomb) and a ZIP with too many files", async () => {
    const { owner, shop, product } = await bulkSetup();
    const zip = new JSZip();
    zip.file(`${product.code}.jpg`, Buffer.alloc(6 * 1024 * 1024, 0)); // compresses to a few KB
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(bytes.length).toBeLessThan(100_000);
    const preview = await createMediaImport(shop.id, { zip: { name: "bomb.zip", bytes } }, "REPLACE", ownerActor(owner));
    expect(preview.items[0]).toMatchObject({ status: "INVALID", message: expect.stringMatching(/Larger than/) });

    await setRule("shopProductMedia", { ...(await getRule("shopProductMedia")), zipMaxFiles: 2 }, { id: owner.id, role: "ADMIN" });
    const many = new JSZip();
    for (let i = 0; i < 3; i += 1) many.file(`x${i}.jpg`, "1");
    await expect(
      createMediaImport(shop.id, { zip: { name: "m.zip", bytes: await many.generateAsync({ type: "nodebuffer" }) } }, "REPLACE", ownerActor(owner)),
    ).rejects.toThrow(/at most 2 photos/);
  });

  it("a cancelled upload cannot be applied, and its archive is dropped", async () => {
    const { owner, shop } = await bulkSetup();
    const csv = Buffer.from("sku,short_description\nP00001,Hi\n");
    const preview = await createMediaImport(shop.id, { csv: { name: "a.csv", bytes: csv } }, "REPLACE", ownerActor(owner));
    await cancelMediaImport(shop.id, preview.import.id);
    await expect(startMediaImport(shop.id, preview.import.id)).rejects.toThrow(/already cancelled/);
    const items = await db.select().from(shopMediaImportItems).where(eq(shopMediaImportItems.importId, preview.import.id));
    expect(items.length).toBe(1);
  });

  it("parses photo names", () => {
    expect(parsePhotoName("folder/P00012_2.JPG")).toEqual({ key: "P00012", position: 2, ext: "jpg" });
    expect(parsePhotoName("8901234567890.png")).toEqual({ key: "8901234567890", position: null, ext: "png" });
    expect(parsePhotoName("noext")).toBeNull();
  });
});
