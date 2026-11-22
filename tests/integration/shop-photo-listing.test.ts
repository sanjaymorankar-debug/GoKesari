/**
 * Add product by photo + voice (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md), against real
 * PostgreSQL and the real photo pipeline, with the AI provider MOCKED (no AI call is ever made):
 *   - flag off → every route and service refused (404), the page hidden
 *   - master match by GTIN → linked, no new product
 *   - match by brand + name + pack → linked; another pack size is not a match
 *   - no match → a new product through createProductForShop, waiting for admin review, photo through the pipeline
 *   - price above the MRP read from the pack → warned and refused until corrected
 *   - unreadable photo → retake; voice falls back to AI only when the reader is incomplete
 *   - only the shop's owner; AI-vs-published kept for the accuracy report; unused photos purged after retention
 */
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
  structured: null as unknown as import("vitest").Mock<(...args: unknown[]) => Promise<unknown>>,
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

// The AI provider is mocked: the test says what the "model" read.
vi.mock("@/server/ai/providers/claude", async () => {
  const { vi: v } = await import("vitest");
  state.structured = v.fn();
  return {
    claudeProvider: {
      name: "claude",
      available: () => true,
      defaultModel: () => "test-model",
      pricePerMTok: () => ({ input: 1, output: 5 }),
      structured: (...args: unknown[]) => state.structured(...args),
    },
  };
});

import { POST as draftsPost } from "@/app/api/shops/[id]/photo-listing/drafts/route";
import { POST as voicePost } from "@/app/api/shops/[id]/photo-listing/voice/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  aiUsageLog,
  brands,
  inventoryMovements,
  productImages,
  products,
  shopListingDetails,
  shopPhotoListingPhotos,
  shopPhotoListings,
  shopProducts,
} from "@/server/db/schema";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import {
  parseSpokenPriceStock,
  photoListingReport,
  publishPhotoListing,
  purgeExpiredPhotoListingPhotos,
  readProductPhotos,
  type PhotoListingActor,
  type ProductPhotoRead,
  type PublishInput,
} from "@/server/services/shop-photo-listing";
import { createCategory, createProduct, createShop, createUser, linkShopCategory, resetDatabase } from "../helpers/fixtures";

let owner: { id: string; role: UserRole; email: string; name: string | null };
let admin: { id: string; role: UserRole };
let shopId: string;
let categoryId: string;
let photo: Buffer;

const F = <T,>(value: T | null, confidence = 95) => ({ value, confidence });

function aiRead(over: Partial<ProductPhotoRead> = {}): ProductPhotoRead {
  return {
    readable: true,
    unreadableReason: null,
    brand: F("Gokul"),
    name: F("Toned Milk"),
    variant: F(null),
    packSize: F(1),
    packUnit: F("L"),
    mrpRupees: F(62),
    category: F("Milk"),
    subCategory: F("Toned milk"),
    barcode: F(null),
    fssaiNumber: F("10012022000123", 60),
    ingredients: F("Toned milk", 80),
    vegMark: F("VEG"),
    manufacturer: F("Gokul Dairy, Kolhapur"),
    expiry: F(null),
    descriptionEn: "Fresh toned milk in a 1 litre pack.",
    descriptionLocal: "१ लिटर पॅकमधील ताजे टोन्ड दूध.",
    specsEn: ["1 L pack", "Toned milk"],
    specsLocal: ["१ लिटर पॅक"],
    ...over,
  };
}

function aiAnswers(output: unknown) {
  state.structured.mockResolvedValueOnce({ output, usage: { inputTokens: 1000, outputTokens: 200 }, model: "test-model" });
}

const actor = (): PhotoListingActor => ({ id: owner.id, role: owner.role });

type PublishOverrides = Omit<Partial<PublishInput>, "fields" | "price"> & { fields?: Partial<PublishInput["fields"]>; price?: Partial<PublishInput["price"]> };

function publishBody(over: PublishOverrides = {}): PublishInput {
  return {
    matchProductId: over.matchProductId ?? null,
    photoIds: over.photoIds ?? [],
    confirmDuplicate: over.confirmDuplicate ?? false,
    fields: {
      brand: "Gokul", name: "Toned Milk", variant: null, packSize: 1, packUnit: "L", mrpRupees: 62, categoryId, subCategory: "Toned milk",
      barcode: null, fssaiNumber: "10012022000123", ingredients: "Toned milk", vegMark: "VEG", manufacturer: "Gokul Dairy, Kolhapur", expiry: null,
      descriptionEn: "Fresh toned milk in a 1 litre pack.", descriptionLocal: "१ लिटर पॅकमधील ताजे टोन्ड दूध.", specsEn: ["1 L pack", "Toned milk"], specsLocal: ["१ लिटर पॅक"],
      ...over.fields,
    },
    price: { pricePaise: 6000, priceUnit: "litre", stock: 50, stockUnit: "piece", customUnit: null, voiceText: "₹60 per litre, 50 bottles", ...over.price },
  };
}

async function flagOn() {
  await setFeatureFlag("shop_photo_listing_enabled", { enabled: true, districtCodes: null }, "Feature 2 test", admin);
}

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  resetRateLimits();
  state.structured.mockReset();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  const u = await createUser({ role: "SHOP_OWNER" });
  owner = { id: u.id, role: "SHOP_OWNER", email: u.email, name: u.name };
  const shop = await createShop(owner.id);
  shopId = shop.id;
  const category = await createCategory({ name: "Milk" });
  categoryId = category.id;
  await linkShopCategory(shopId, categoryId);
  photo = await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 230, g: 240, b: 250 } } }).jpeg().toBuffer();
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
});
afterEach(() => {
  state.session = null;
});

describe("flag off", () => {
  it("refuses the service and the routes with 404, and never calls AI", async () => {
    await expect(readProductPhotos(shopId, actor(), [{ bytes: photo }])).rejects.toMatchObject({ code: "NOT_FOUND", details: { reason: "FEATURE_NOT_AVAILABLE" } });
    await expect(parseSpokenPriceStock(shopId, actor(), "₹60 per litre")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(publishPhotoListing(shopId, actor(), "00000000-0000-0000-0000-000000000000", publishBody())).rejects.toMatchObject({ code: "NOT_FOUND" });

    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: owner.role, status: "ACTIVE" } };
    const form = new FormData();
    form.append("photo", new File([new Uint8Array(photo)], "p.jpg", { type: "image/jpeg" }));
    const res = await draftsPost(new Request(`http://x/api/shops/${shopId}/photo-listing/drafts`, { method: "POST", body: form }) as unknown as NextRequest, { params: Promise.resolve({ id: shopId }) });
    expect(res.status).toBe(404);
    const voice = await voicePost(
      new Request(`http://x/api/shops/${shopId}/photo-listing/voice`, { method: "POST", body: JSON.stringify({ text: "₹60" }), headers: { "content-type": "application/json" } }) as unknown as NextRequest,
      { params: Promise.resolve({ id: shopId }) },
    );
    expect(voice.status).toBe(404);
    expect(state.structured).not.toHaveBeenCalled();
  });
});

describe("with the flag on", () => {
  beforeEach(flagOn);

  it("matches a master product by GTIN and links it: no duplicate; stock in the ledger; shop MRP for this shop only", async () => {
    const master = await createProduct(categoryId, { name: "Gokul Toned Milk 1 L", unit: "L" });
    await db.update(products).set({ gtin: "8901234567897", mrpPaise: 6000 }).where(eq(products.id, master.id));
    aiAnswers(aiRead({ barcode: F("08901234567897"), name: F("Taaza") }));

    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo, side: "FRONT" }, { bytes: photo, side: "BARCODE" }]);
    expect(draft.status).toBe("DRAFT");
    expect(draft.match).toMatchObject({ productId: master.id, reason: "GTIN", listed: false });
    expect(draft.lowConfidence).toContain("fssaiNumber");
    expect(draft.photos).toHaveLength(2);
    expect(draft.localLang).toBe("mr"); // Pune PIN 411001
    const before = (await db.select().from(products)).length;

    const result = await publishPhotoListing(shopId, actor(), draft.id, publishBody({ matchProductId: master.id, fields: { mrpRupees: 62, barcode: "8901234567897" } }));
    expect(result).toMatchObject({ outcome: "LINKED_MASTER", productId: master.id, pricePaise: 6000, stock: 50 });
    expect((await db.select().from(products)).length).toBe(before);
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, result.shopProductId));
    expect(listing).toMatchObject({ onlinePricePaise: 6000, offlinePricePaise: 6000, onlineSaleEnabled: true, onlineStock: 50 });
    expect(await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, listing.id))).toHaveLength(1);
    // The pack says ₹62, the catalogue ₹60: ₹62 is this shop's MRP; the master is unchanged.
    const [details] = await db.select().from(shopListingDetails).where(eq(shopListingDetails.shopProductId, listing.id));
    expect(details.mrpPaise).toBe(6200);
    expect((await db.select().from(products).where(eq(products.id, master.id)))[0].mrpPaise).toBe(6000);
    // An AI call was logged (cost/latency), never the photo.
    expect(await db.select().from(aiUsageLog).where(eq(aiUsageLog.feature, "PRODUCT_PHOTO"))).toHaveLength(1);
  });

  it("matches by brand + name + pack, but not a different pack size", async () => {
    const [brand] = await db.insert(brands).values({ name: "Gokul", slug: "gokul" }).returning();
    const litre = await createProduct(categoryId, { name: "Toned Milk", unit: "L" });
    await db.update(products).set({ brandId: brand.id, netQuantity: 1000, netQuantityUnit: "ml" }).where(eq(products.id, litre.id));
    const half = await createProduct(categoryId, { name: "Toned Milk", unit: "ml", unitSizeMilli: 500_000 });
    await db.update(products).set({ brandId: brand.id, netQuantity: 500, netQuantityUnit: "ml" }).where(eq(products.id, half.id));

    aiAnswers(aiRead());
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo }]);
    expect(draft.match).toMatchObject({ productId: litre.id, reason: "BRAND_NAME_PACK" });

    aiAnswers(aiRead({ packSize: F(500), packUnit: F("ml") }));
    expect((await readProductPhotos(shopId, actor(), [{ bytes: photo }])).match).toMatchObject({ productId: half.id });

    aiAnswers(aiRead({ packSize: F(200), packUnit: F("ml") }));
    expect((await readProductPhotos(shopId, actor(), [{ bytes: photo }])).match).toBeNull();

    // A fuzzy name of a product without a brand row: the PMD name comparison with the same pack.
    const other = await createProduct(categoryId, { name: "Amul Taaza Homogenised Toned Milk 1 L", unit: "L" });
    aiAnswers(aiRead({ brand: F("Amul"), name: F("Taaza Homogenised Toned Milk") }));
    expect((await readProductPhotos(shopId, actor(), [{ bytes: photo }])).match).toMatchObject({ productId: other.id, reason: "BRAND_NAME_PACK" });

    const linked = await publishPhotoListing(shopId, actor(), draft.id, publishBody({ matchProductId: litre.id }));
    expect(linked.outcome).toBe("LINKED_MASTER");
  });

  it("creates a new product through the normal service: pending review, price/stock/unit set, photo through the pipeline", async () => {
    aiAnswers(aiRead({ brand: F("Kesar Farm"), name: F("Buffalo Milk"), mrpRupees: F(null), fssaiNumber: F(null), packSize: F(500), packUnit: F("ml") }));
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo, side: "FRONT" }, { bytes: photo, side: "BACK" }]);
    expect(draft.match).toBeNull();
    expect(draft.categoryId).toBe(categoryId);

    const result = await publishPhotoListing(
      shopId,
      actor(),
      draft.id,
      publishBody({
        photoIds: [draft.photos[0].id],
        fields: { brand: "Kesar Farm", name: "Buffalo Milk", packSize: 500, packUnit: "ml", mrpRupees: null, fssaiNumber: null, manufacturer: "Kesar Farm, Pune" },
        price: { pricePaise: 8000, priceUnit: "litre", stock: 40, stockUnit: "piece" },
      }),
    );
    expect(result).toMatchObject({ outcome: "CREATED_PENDING", approvalStatus: "PENDING_APPROVAL", pricePaise: 4000, stock: 40, photosAdded: 1, photoErrors: [] });
    const [product] = await db.select().from(products).where(eq(products.id, result.productId));
    expect(product).toMatchObject({
      name: "Kesar Farm Buffalo Milk 500 ml",
      unit: "ml",
      unitSizeMilli: 500_000,
      approvalStatus: "PENDING_APPROVAL",
      createdBy: owner.id,
      netQuantity: 500,
      netQuantityUnit: "ml",
      manufacturerName: "Kesar Farm, Pune",
      kind: "PACKAGED",
      categoryId,
    });
    expect(product.description).toContain("टोन्ड");
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, result.shopProductId));
    expect(listing).toMatchObject({ onlinePricePaise: 4000, onlineStock: 40, onlineSaleEnabled: true });
    const images = await db.select().from(productImages).where(eq(productImages.shopProductId, listing.id));
    expect(images).toHaveLength(1);
    expect(images[0].url).toMatch(/^\/api\/images\//);
    // The used photo's draft copy is gone; the unused one waits for the retention sweep.
    expect(await db.select().from(shopPhotoListingPhotos).where(eq(shopPhotoListingPhotos.listingId, draft.id))).toHaveLength(1);

    const [row] = await db.select().from(shopPhotoListings).where(eq(shopPhotoListings.id, draft.id));
    expect(row).toMatchObject({ status: "PUBLISHED", outcome: "CREATED_PENDING", productId: product.id, pricePaise: 4000 });
    expect(row.changedFields).toEqual(["manufacturer"]);
    expect(row.fieldsKept).toBeGreaterThan(5);

    const report = await photoListingReport(30);
    expect(report).toMatchObject({ published: 1, byOutcome: { CREATED_PENDING: 1 }, fieldsChanged: 1 });
    expect(report.changedByField).toEqual([{ field: "manufacturer", changed: 1 }]);
    expect(report.accuracyPct).toBeGreaterThan(80);

    // Publishing twice is refused.
    await expect(publishPhotoListing(shopId, actor(), draft.id, publishBody())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("loose goods by the kilo may go without a price; packaged goods may not", async () => {
    aiAnswers(aiRead({ brand: F(null), name: F("Toor Dal"), packSize: F(null), packUnit: F(null), mrpRupees: F(null) }));
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo }]);
    await expect(
      publishPhotoListing(shopId, actor(), draft.id, publishBody({ fields: { brand: null, name: "Toor Dal", packSize: 1, packUnit: "kg", mrpRupees: null, barcode: "8901234500011" }, price: { pricePaise: null, priceUnit: "kg", stock: 20, stockUnit: "kg" } })),
    ).rejects.toMatchObject({ details: { reason: "PRICE_REQUIRED" } });
    const loose = await publishPhotoListing(shopId, actor(), draft.id, publishBody({ fields: { brand: null, name: "Toor Dal", packSize: null, packUnit: null, mrpRupees: null }, price: { pricePaise: null, priceUnit: "kg", stock: 20.5, stockUnit: "kg" } }));
    const [product] = await db.select().from(products).where(eq(products.id, loose.productId));
    expect(product).toMatchObject({ kind: "LOOSE", unit: "kg" });
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, loose.shopProductId));
    expect(listing).toMatchObject({ onlinePricePaise: null, onlineSaleEnabled: false, onlineStock: 20.5 });
  });

  it("warns and refuses a price above the MRP read from the pack, then publishes once corrected", async () => {
    aiAnswers(aiRead({ mrpRupees: F(55) }));
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo }]);
    await expect(publishPhotoListing(shopId, actor(), draft.id, publishBody({ fields: { mrpRupees: 55 } }))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "PRICE_ABOVE_MRP", pricePaise: 6000, mrpPaise: 5500 },
    });
    expect(await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))).toHaveLength(0);
    // The owner says the AI misread the MRP (₹65): accepted, and recorded as a corrected field.
    const ok = await publishPhotoListing(shopId, actor(), draft.id, publishBody({ fields: { mrpRupees: 65 } }));
    expect(ok.outcome).toBe("CREATED_PENDING");
    const [row] = await db.select().from(shopPhotoListings).where(eq(shopPhotoListings.id, draft.id));
    expect(row.changedFields).toContain("mrpRupees");
  });

  it("asks for a retake when the photo cannot be read", async () => {
    aiAnswers(aiRead({ readable: false, unreadableReason: "BLURRY", brand: F(null), name: F(null) }));
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo }]);
    expect(draft).toMatchObject({ status: "UNREADABLE", unreadableReason: "BLURRY" });
    expect(draft.retakeMessage).toMatch(/blurry/i);
    await expect(publishPhotoListing(shopId, actor(), draft.id, publishBody())).rejects.toMatchObject({ details: { reason: "UNREADABLE" } });
    aiAnswers(null); // the model declined
    expect((await readProductPhotos(shopId, actor(), [{ bytes: photo }])).status).toBe("UNREADABLE");
  });

  it("refuses a file that is not a photo and more photos than the rule allows", async () => {
    await expect(readProductPhotos(shopId, actor(), [{ bytes: Buffer.from("not an image at all") }])).rejects.toMatchObject({ details: { reason: "PHOTO_BAD_TYPE" } });
    await expect(readProductPhotos(shopId, actor(), Array.from({ length: 5 }, () => ({ bytes: photo })))).rejects.toMatchObject({ details: { reason: "TOO_MANY_PHOTOS" } });
    expect(state.structured).not.toHaveBeenCalled();
  });

  it("only the shop's owner (or catalogue support staff) may use it", async () => {
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(readProductPhotos(shopId, { id: stranger.id, role: "SHOP_OWNER" }, [{ bytes: photo }])).rejects.toMatchObject({ code: "FORBIDDEN" });
    const customer = await createUser({ role: "CUSTOMER" });
    await expect(parseSpokenPriceStock(shopId, { id: customer.id, role: "CUSTOMER" }, "₹60")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads price and stock without AI when it can, and asks AI only for what is missing", async () => {
    const full = await parseSpokenPriceStock(shopId, actor(), "साठ रुपये लिटर पन्नास बाटल्या");
    expect(full).toMatchObject({ aiUsed: false, parse: { pricePaise: 6000, priceUnit: "litre", stock: 50, complete: true } });
    expect(full.readBack.mr).toBe("किंमत ₹60 प्रति लिटर, साठा 50 नग");
    expect(state.structured).not.toHaveBeenCalled();

    // The reader finds the price but no stock figure ("भरपूर" = plenty): AI is asked, and fills only the stock.
    aiAnswers({ priceRupees: 99, priceUnit: "litre", stock: 50, stockUnit: "piece", customUnit: null });
    const partial = await parseSpokenPriceStock(shopId, actor(), "दूध साठ रुपये लिटर, माल भरपूर आहे");
    expect(state.structured).toHaveBeenCalledTimes(1);
    expect(partial).toMatchObject({ aiUsed: true, parse: { pricePaise: 6000, priceUnit: "litre", stock: 50, stockUnit: "piece", complete: true } });
    expect(await db.select().from(aiUsageLog).where(eq(aiUsageLog.feature, "VOICE_PARSE"))).toHaveLength(1);

    // AI switched off: the owner gets what the reader found, no error.
    state.structured.mockRejectedValueOnce(new Error("provider down"));
    const down = await parseSpokenPriceStock(shopId, actor(), "₹60 per litre");
    expect(down).toMatchObject({ aiUsed: false, parse: { pricePaise: 6000, stock: null, complete: false } });
  });

  it("deletes photos not used after the retention days, keeping the row for the report", async () => {
    aiAnswers(aiRead());
    const draft = await readProductPhotos(shopId, actor(), [{ bytes: photo }, { bytes: photo }]);
    expect(await purgeExpiredPhotoListingPhotos(new Date())).toEqual({ drafts: 0, photos: 0 });
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await purgeExpiredPhotoListingPhotos(later)).toEqual({ drafts: 1, photos: 2 });
    const [row] = await db.select().from(shopPhotoListings).where(eq(shopPhotoListings.id, draft.id));
    expect(row).toMatchObject({ status: "DISCARDED" });
    expect(row.photosDeletedAt).not.toBeNull();
    expect(await db.select().from(shopPhotoListingPhotos).where(eq(shopPhotoListingPhotos.listingId, draft.id))).toHaveLength(0);
  });
});
