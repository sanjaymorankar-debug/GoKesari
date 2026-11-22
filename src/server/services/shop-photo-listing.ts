/**
 * Add product by photo + voice (owner brief 22-Nov-2026; docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md).
 *
 * A shop owner photographs a product (1–4 photos: front, back, label, barcode) and says or types its price,
 * stock and selling unit. Then:
 *   1. AI reads the photos (runAi PRODUCT_PHOTO): brand, name, variant, pack, MRP, category, barcode, FSSAI,
 *      ingredients, veg mark, manufacturer, expiry — each with a confidence — and a short description and spec
 *      list in English and the shop's local language. The result is a DRAFT; an unreadable photo is UNREADABLE
 *      with the reason, and the owner retakes it.
 *   2. The master catalogue is checked first: by barcode/GTIN (barcode-lookup, every stored GTIN form), then by
 *      brand + name + pack (product-master's duplicate check, then the PMD name comparison). A match is linked:
 *      no duplicate product.
 *   3. On "Publish to my shop" the existing services do the writing: createShopProduct / updateShopProduct for a
 *      matched product, createProductForShop (admin pending review + duplicate check) for a new one. A shop's MRP
 *      that differs from the master's goes to that shop's listing only (shop_listing_details), as in the bulk
 *      upload. The chosen photos go through the product photo pipeline (shop-media uploadListingPhoto).
 *   4. What the AI read and what the owner published are kept side by side (shop_photo_listings) for the admin's
 *      accuracy report. Photos not used are deleted by the daily cron after smartShopping.photoRetentionDays.
 *
 * Only the shop's owner (and support staff holding PRODUCT_CREATE_ANY, as for the "Create new product" form)
 * may use it; catalogue-scope staff can edit photos and descriptions but not add products, so they cannot use
 * this either. Everything is refused (404) while the flag shop_photo_listing_enabled is off for the shop.
 * AI calls and photo processing never run inside a database transaction.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  packUnitFromLabel,
  parsePriceStock,
  priceAboveMrp,
  readBack,
  SELLING_UNITS,
  toListingQuantities,
  type PriceStock,
  type PriceStockParse,
} from "@/lib/price-stock-parse";
import { packInBase } from "@/lib/qty-words";
import { MAX_PRICE_PAISE } from "@/lib/price-rules";
import { AiUnavailableError, runAi } from "@/server/ai/provider";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { checkCommissionMilestonesSafely } from "@/server/dealers/commission";
import { db, type DbClient } from "@/server/db";
import {
  aiUsageLog,
  brands,
  productCategories,
  products,
  shopListingDetails,
  shopPhotoListingPhotos,
  shopPhotoListings,
  shopProducts,
  shops,
  type PhotoListingOutcome,
  type PhotoSide,
  type Product,
  type ShopPhotoListing,
  type UserRole,
} from "@/server/db/schema";
import { precheckPhoto } from "@/server/media/photo-pipeline";
import { compareNames } from "@/server/pmd/match/score";
import { localBannerLanguage } from "@/server/shop-banner/render";
import { findProductByBarcode } from "./barcode-lookup";
import { createProductForShop, createShopProduct, updateShopProduct } from "./catalogue";
import { requireFeatureForShop } from "./feature-flags";
import { appliesImmediately, submitPriceRequests, type ProposedChange } from "./price-requests";
import { addCategoryToShop } from "./product-categories";
import { findDuplicateCandidates } from "./product-master";
import { getRule } from "./settings";
import { uploadListingPhoto } from "./shop-media";

export const PHOTO_LISTING_FLAG = "shop_photo_listing_enabled" as const;
export const PHOTO_SIDES = ["FRONT", "BACK", "LABEL", "BARCODE", "OTHER"] as const satisfies readonly PhotoSide[];

export interface PhotoListingActor {
  id: string;
  role: UserRole;
}

/* ------------------------------------------------------------ AI schema */

const aiField = <T extends z.ZodType>(value: T) => z.object({ value: value.nullable(), confidence: z.number() });

/** What the AI returns for the photos of one product. Confidence is 0–100 (clamped on our side). */
export const productPhotoSchema = z.object({
  readable: z.boolean(),
  unreadableReason: z.enum(["BLURRY", "DARK", "NOT_A_PRODUCT", "CUT_OFF", "OTHER"]).nullable(),
  brand: aiField(z.string()),
  name: aiField(z.string()),
  variant: aiField(z.string()),
  packSize: aiField(z.number()),
  packUnit: aiField(z.string()),
  mrpRupees: aiField(z.number()),
  category: aiField(z.string()),
  subCategory: aiField(z.string()),
  barcode: aiField(z.string()),
  fssaiNumber: aiField(z.string()),
  ingredients: aiField(z.string()),
  vegMark: aiField(z.enum(["VEG", "NON_VEG", "NONE"])),
  manufacturer: aiField(z.string()),
  expiry: aiField(z.string()),
  descriptionEn: z.string(),
  descriptionLocal: z.string(),
  specsEn: z.array(z.string()),
  specsLocal: z.array(z.string()),
});
export type ProductPhotoRead = z.infer<typeof productPhotoSchema>;

/** The fields compared for accuracy (AI value vs what the owner published). */
export const AI_FIELD_KEYS = [
  "brand", "name", "variant", "packSize", "packUnit", "mrpRupees", "category", "subCategory", "barcode",
  "fssaiNumber", "ingredients", "vegMark", "manufacturer", "expiry",
] as const;
export type AiFieldKey = (typeof AI_FIELD_KEYS)[number];
const TEXT_KEYS = ["descriptionEn", "descriptionLocal", "specsEn", "specsLocal"] as const;

const LANG_NAMES: Record<"hi" | "mr", string> = { hi: "Hindi (Devanagari)", mr: "Marathi (Devanagari)" };

function photoInstructions(localLang: "hi" | "mr", categories: string[]): string {
  return [
    "You read photos of ONE retail product in an Indian shop (front, back, label and/or barcode side) and fill a product record.",
    "Read only what is printed or clearly visible. Never guess a barcode, MRP, FSSAI number or expiry: leave value null when you cannot read it.",
    "Every field has a confidence from 0 to 100: how sure you are the value is exactly right.",
    "brand: the brand name. name: the product name without the brand and without the pack size. variant: flavour, colour or type (e.g. 'Toned', 'Masala').",
    "packSize + packUnit: the net quantity, unit one of g, kg, ml, L, piece, pack (e.g. 500 + g). mrpRupees: the printed MRP in rupees (incl. of all taxes).",
    "barcode: the EAN/GTIN digits under the barcode if readable. fssaiNumber: the 14-digit FSSAI licence number. vegMark: VEG (green dot), NON_VEG (brown/red triangle or dot) or NONE.",
    "manufacturer: who made or marketed it. expiry: best-before / use-by / expiry as printed. ingredients: a short ingredient list or key specs.",
    `category: choose the closest from this list, or null: ${categories.slice(0, 150).join("; ") || "(none)"}. subCategory: a short sub-category guess.`,
    `descriptionEn: two short sentences for shoppers, in English. descriptionLocal: the same in ${LANG_NAMES[localLang]}.`,
    `specsEn: 3–6 short spec lines in English. specsLocal: the same lines in ${LANG_NAMES[localLang]}.`,
    "If the photos are too blurry, too dark, cut off or not a product, set readable false, give unreadableReason, and leave the fields null.",
  ].join("\n");
}

const voiceSchema = z.object({
  priceRupees: z.number().nullable(),
  priceUnit: z.enum(SELLING_UNITS).nullable(),
  stock: z.number().nullable(),
  stockUnit: z.enum(SELLING_UNITS).nullable(),
  customUnit: z.string().nullable(),
});

const VOICE_INSTRUCTIONS = [
  "A shop owner in India said or typed the selling price, the stock and the selling unit of one product, in English, Hindi or Marathi (number words allowed).",
  "Return priceRupees (price of one priceUnit), priceUnit, stock (how many stockUnit are in stock), stockUnit.",
  "Units: piece (nug, नग, bottle), kg, g, litre, ml, dozen, packet, box, metre, or custom with customUnit set to the owner's word.",
  "Use null for anything not said. Do not invent numbers.",
].join("\n");

/* ------------------------------------------------------------ access */

interface Access {
  shop: { id: string; ownerId: string; pincode: string | null; state: string | null; name: string };
  isOwner: boolean;
}

/** Flag on for the shop (else 404), then the shop's owner or support staff with PRODUCT_CREATE_ANY. */
export async function assertPhotoListingAccess(shopId: string, actor: PhotoListingActor): Promise<Access> {
  const [shop] = await db
    .select({ id: shops.id, ownerId: shops.ownerId, pincode: shops.pincode, state: shops.state, name: shops.name })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  await requireFeatureForShop(PHOTO_LISTING_FLAG, shop);
  if (shop.ownerId === actor.id) return { shop, isOwner: true };
  if (can(actor.role, PERMISSIONS.PRODUCT_CREATE_ANY)) return { shop, isOwner: false };
  throw forbidden("Only the shop's owner can add products by photo.");
}

/** The role the catalogue services are called with: an owner acts as SHOP_OWNER (their product waits for review). */
function catalogueActor(actor: PhotoListingActor, isOwner: boolean): { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" } {
  if (isOwner) return { id: actor.id, role: "SHOP_OWNER" };
  return { id: actor.id, role: actor.role === "ADMIN" ? "ADMIN" : "OPERATOR" };
}

export function shopLocalLang(shop: { state: string | null; pincode: string | null }): "hi" | "mr" {
  return localBannerLanguage({ state: shop.state, pincode: shop.pincode });
}

/* ------------------------------------------------------------ views */

export type FieldValue = string | number | null;
export interface AiFieldView {
  value: FieldValue;
  confidence: number;
}

export interface MasterMatch {
  productId: string;
  name: string;
  reason: "GTIN" | "BRAND_NAME_PACK";
  /** 0–100. */
  score: number;
  mrpPaise: number | null;
  unit: string;
  unitSizeMilli: number;
  kind: "PACKAGED" | "LOOSE";
  approved: boolean;
  listed: boolean;
  imageUrl: string | null;
}

export interface PhotoListingDraftView {
  id: string;
  status: ShopPhotoListing["status"];
  unreadableReason: string | null;
  /** Shown with an UNREADABLE draft. */
  retakeMessage: string | null;
  createdAt: Date;
  photos: { id: string; side: PhotoSide; url: string }[];
  fields: Record<AiFieldKey, AiFieldView>;
  descriptionEn: string;
  descriptionLocal: string;
  specsEn: string[];
  specsLocal: string[];
  /** The category the AI's guess resolves to (products.category_id), or null. */
  categoryId: string | null;
  localLang: "hi" | "mr";
  lowConfidenceBelow: number;
  lowConfidence: AiFieldKey[];
  match: MasterMatch | null;
}

const RETAKE: Record<string, string> = {
  BLURRY: "The photo is blurry. Hold the phone steady, tap to focus and take it again.",
  DARK: "The photo is too dark. Move to the light and take it again.",
  NOT_A_PRODUCT: "We could not see a product in the photo. Take the front of the pack again.",
  CUT_OFF: "Part of the pack is cut off. Fit the whole label in the photo and take it again.",
  OTHER: "We could not read the photo. Please take it again, closer and in good light.",
};

const clampConfidence = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);

function emptyFields(): Record<AiFieldKey, AiFieldView> {
  return Object.fromEntries(AI_FIELD_KEYS.map((k) => [k, { value: null, confidence: 0 }])) as Record<AiFieldKey, AiFieldView>;
}

function fieldsOf(ai: Record<string, unknown> | null): Record<AiFieldKey, AiFieldView> {
  const out = emptyFields();
  if (!ai) return out;
  for (const key of AI_FIELD_KEYS) {
    const f = ai[key] as { value?: unknown; confidence?: unknown } | undefined;
    const value = f?.value;
    out[key] = {
      value: typeof value === "string" ? value.trim() || null : typeof value === "number" && Number.isFinite(value) ? value : null,
      confidence: value == null ? 0 : clampConfidence(f?.confidence),
    };
  }
  return out;
}

const photoUrl = (shopId: string, draftId: string, photoId: string) => `/api/shops/${shopId}/photo-listing/drafts/${draftId}/photos/${photoId}`;

async function toView(row: ShopPhotoListing, lowConfidenceBelow: number, client: DbClient = db): Promise<PhotoListingDraftView> {
  const photos = await client
    .select({ id: shopPhotoListingPhotos.id, side: shopPhotoListingPhotos.side })
    .from(shopPhotoListingPhotos)
    .where(eq(shopPhotoListingPhotos.listingId, row.id))
    .orderBy(asc(shopPhotoListingPhotos.position));
  const ai = (row.aiFields ?? null) as Record<string, unknown> | null;
  const fields = fieldsOf(ai);
  const match = (ai?.match as MasterMatch | undefined) ?? null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : []);
  return {
    id: row.id,
    status: row.status,
    unreadableReason: row.unreadableReason,
    retakeMessage: row.status === "UNREADABLE" ? RETAKE[row.unreadableReason ?? "OTHER"] ?? RETAKE.OTHER : null,
    createdAt: row.createdAt,
    photos: photos.map((p) => ({ id: p.id, side: p.side, url: photoUrl(row.shopId, row.id, p.id) })),
    fields,
    descriptionEn: typeof ai?.descriptionEn === "string" ? ai.descriptionEn : "",
    descriptionLocal: typeof ai?.descriptionLocal === "string" ? ai.descriptionLocal : "",
    specsEn: strings(ai?.specsEn),
    specsLocal: strings(ai?.specsLocal),
    categoryId: typeof ai?.categoryId === "string" ? ai.categoryId : null,
    localLang: row.localLang === "mr" ? "mr" : "hi",
    lowConfidenceBelow,
    lowConfidence: AI_FIELD_KEYS.filter((k) => fields[k].value !== null && fields[k].confidence < lowConfidenceBelow),
    match,
  };
}

/* ------------------------------------------------------------ master match */

const PACK_UNITS_TO_BASE: Record<string, { unit: "g" | "ml" | "piece" | "pack"; factor: number }> = {
  g: { unit: "g", factor: 1 }, kg: { unit: "g", factor: 1000 }, ml: { unit: "ml", factor: 1 }, l: { unit: "ml", factor: 1000 },
  litre: { unit: "ml", factor: 1000 }, piece: { unit: "piece", factor: 1 }, pack: { unit: "pack", factor: 1 },
};

/** "500", "g" → 500 g; "1", "L" → 1000 ml. */
function labelPackInBase(size: FieldValue, unit: FieldValue): { amount: number; unit: string } | null {
  if (typeof size !== "number" || !(size > 0) || typeof unit !== "string") return null;
  const sellingUnit = packUnitFromLabel(unit);
  const key = sellingUnit === "litre" ? "l" : sellingUnit === "packet" ? "pack" : (sellingUnit ?? unit.toLowerCase());
  const base = PACK_UNITS_TO_BASE[key];
  return base ? { amount: Math.round(size * base.factor * 1000) / 1000, unit: base.unit } : null;
}

/** A catalogue product's printed net quantity (net_quantity + unit), else its sellable unit (unit + size). */
function productPackInBase(p: Pick<Product, "netQuantity" | "netQuantityUnit" | "unit" | "unitSizeMilli">): { amount: number; unit: string } | null {
  if (p.netQuantity != null && p.netQuantityUnit) return labelPackInBase(p.netQuantity, p.netQuantityUnit);
  return packInBase(p.unit, p.unitSizeMilli);
}

function samePack(a: { amount: number; unit: string } | null, b: { amount: number; unit: string } | null): boolean | null {
  if (!a || !b) return null;
  if (a.unit !== b.unit) return false;
  return Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) <= 0.02;
}

/** Strips a trailing pack size ("Taaza Milk 500 ml" → "Taaza Milk") so names compare on their words. */
const withoutPack = (name: string) => name.replace(/\s*\d+(\.\d+)?\s*(g|gm|kg|ml|l|ltr|litre|pcs?|pack)\b\.?/gi, " ").replace(/\s+/g, " ").trim();

async function listingOf(shopId: string, productId: string, client: DbClient = db): Promise<{ id: string } | undefined> {
  const [row] = await client
    .select({ id: shopProducts.id })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId), isNull(shopProducts.deletedAt)));
  return row;
}

async function resolveBrandId(name: string | null): Promise<string | null> {
  if (!name?.trim()) return null;
  const [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(sql`lower(${brands.name}) = ${name.trim().toLowerCase()}`, eq(brands.isActive, true)))
    .limit(1);
  return row?.id ?? null;
}

async function toMatch(shopId: string, product: Product, reason: MasterMatch["reason"], score: number): Promise<MasterMatch> {
  return {
    productId: product.id,
    name: product.name,
    reason,
    score: Math.round(score),
    mrpPaise: product.mrpPaise,
    unit: product.unit,
    unitSizeMilli: product.unitSizeMilli,
    kind: product.kind,
    approved: product.approvalStatus === "APPROVED",
    listed: Boolean(await listingOf(shopId, product.id)),
    imageUrl: product.imageUrl,
  };
}

/**
 * The master product these photos show, if the catalogue has it:
 *   1. barcode/GTIN — every stored form (GTIN-14, EAN-13, UPC-A) and the shop-local barcode column;
 *   2. brand + name + pack — product-master's exact duplicate key first, then the PMD name comparison over the
 *      brand's products with the same pack size (a different pack is a different product).
 */
export async function findMasterMatch(
  shopId: string,
  fields: Pick<Record<AiFieldKey, AiFieldView>, "brand" | "name" | "variant" | "packSize" | "packUnit" | "barcode">,
): Promise<MasterMatch | null> {
  const barcode = typeof fields.barcode.value === "string" ? fields.barcode.value : null;
  if (barcode) {
    const hit = await findProductByBarcode(shopId, barcode);
    if (hit?.match) {
      const product = await db.query.products.findFirst({ where: eq(products.id, hit.match.productId) });
      if (product && product.approvalStatus !== "REJECTED") return toMatch(shopId, product, "GTIN", 100);
    }
  }

  const name = typeof fields.name.value === "string" ? fields.name.value.trim() : "";
  if (name.length < 2) return null;
  const brand = typeof fields.brand.value === "string" ? fields.brand.value.trim() : null;
  const variant = typeof fields.variant.value === "string" ? fields.variant.value.trim() : null;
  const pack = labelPackInBase(fields.packSize.value, fields.packUnit.value);
  const brandId = await resolveBrandId(brand);

  // Product master's own duplicate key (§11): brand + exact name + net quantity + variant.
  if (brandId) {
    const netQuantity = pack && Number.isInteger(pack.amount) ? pack.amount : null;
    for (const candidateName of [name, brand ? `${brand} ${name}` : name]) {
      const exact = await findDuplicateCandidates({ brandId, name: candidateName, netQuantity, netQuantityUnit: pack?.unit ?? null, variant });
      const live = exact.find((c) => c.product.approvalStatus !== "REJECTED" && c.product.isActive);
      if (live) return toMatch(shopId, live.product, "BRAND_NAME_PACK", 95);
    }
  }

  // The PMD comparison over candidates that share the brand (by id or in the name) or the name's first word.
  const full = [brand, name, variant].filter(Boolean).join(" ");
  const firstWord = name.split(/\s+/).find((w) => w.length >= 3) ?? name;
  const candidates = await db
    .select()
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        eq(products.isActive, true),
        ne(products.approvalStatus, "REJECTED"),
        or(
          brandId ? eq(products.brandId, brandId) : undefined,
          brand ? ilike(products.name, `%${brand.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
          ilike(products.name, `%${firstWord.replace(/[%_\\]/g, "\\$&")}%`),
        ),
      ),
    )
    .limit(300);
  let best: { product: Product; score: number } | null = null;
  for (const c of candidates) {
    const cmp = compareNames(withoutPack(full), withoutPack(c.name));
    const packs = samePack(pack, productPackInBase(c));
    if (packs === false) continue; // a different pack size is a different product
    // With no brand on our side, the candidate's words must cover ours; an unknown pack needs a closer name.
    const needed = packs === true ? 0.8 : 0.9;
    if (cmp.score < needed) continue;
    if (brand && !c.brandId && !c.name.toLowerCase().includes(brand.toLowerCase())) continue;
    if (brandId && c.brandId && c.brandId !== brandId) continue;
    const score = cmp.score * 100;
    if (!best || score > best.score) best = { product: c, score };
  }
  return best ? toMatch(shopId, best.product, "BRAND_NAME_PACK", best.score) : null;
}

/* ------------------------------------------------------------ 1. read the photos */

export interface PhotoInput {
  bytes: Buffer;
  side?: PhotoSide;
}

const MB = 1024 * 1024;

/** Upright JPEG, longest side ≤ 2000 px, no EXIF (GPS, camera) — what the AI reads and what is kept for review. */
async function normalisePhoto(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: 60_000_000 })
      .rotate()
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw validationFailed("That file could not be opened as a photo. Take the photo again.", { reason: "PHOTO_UNREADABLE" });
  }
}

/** Active categories for the AI's category guess: the shop's own first. */
async function categoryChoices(shopId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: productCategories.id, name: productCategories.name, carried: sql<boolean>`EXISTS (SELECT 1 FROM shop_product_categories spc WHERE spc.shop_id = ${shopId} AND spc.category_id = ${productCategories.id})` })
    .from(productCategories)
    .where(and(isNull(productCategories.deletedAt), eq(productCategories.isActive, true)))
    .orderBy(asc(productCategories.sortOrder), asc(productCategories.name))
    .limit(400);
  return [...rows.filter((r) => r.carried), ...rows.filter((r) => !r.carried)].map(({ id, name }) => ({ id, name }));
}

/**
 * Reads 1–4 photos of one product with AI and saves a draft for review. An unreadable read is saved as
 * UNREADABLE with the reason (the owner retakes). The AI call runs before any database write.
 */
export async function readProductPhotos(shopId: string, actor: PhotoListingActor, photos: PhotoInput[]): Promise<PhotoListingDraftView> {
  const { shop } = await assertPhotoListingAccess(shopId, actor);
  const rule = await getRule("smartShopping");
  if (photos.length === 0) throw validationFailed("Take at least one photo of the product.");
  if (photos.length > rule.maxPhotosPerProduct) {
    throw validationFailed(`At most ${rule.maxPhotosPerProduct} photos per product (front, back, label, barcode).`, { reason: "TOO_MANY_PHOTOS" });
  }
  const prepared: { bytes: Buffer; side: PhotoSide }[] = [];
  for (const [i, photo] of photos.entries()) {
    precheckPhoto(photo.bytes, { maxUploadBytes: rule.maxUploadMb * MB });
    prepared.push({ bytes: await normalisePhoto(photo.bytes), side: photo.side ?? (i === 0 ? "FRONT" : "OTHER") });
  }

  const localLang = shopLocalLang(shop);
  const categories = await categoryChoices(shopId);
  const result = await runAi(
    { feature: "PRODUCT_PHOTO", userId: actor.id, shopId },
    {
      images: prepared.map((p) => ({ bytes: p.bytes, contentType: "image/jpeg" })),
      text: `Photo sides in order: ${prepared.map((p) => p.side).join(", ")}.`,
      instructions: photoInstructions(localLang, categories.map((c) => c.name)),
      schema: productPhotoSchema,
      maxTokens: 4_000,
    },
  );

  const read = result.output;
  const fields = fieldsOf(read as unknown as Record<string, unknown> | null);
  const readable = Boolean(read?.readable) && (fields.name.value !== null || fields.brand.value !== null || fields.barcode.value !== null);
  const unreadableReason = readable ? null : (read?.unreadableReason ?? (read ? "OTHER" : "OTHER"));
  const categoryName = typeof fields.category.value === "string" ? fields.category.value.toLowerCase() : null;
  const categoryId = categoryName ? (categories.find((c) => c.name.toLowerCase() === categoryName)?.id ?? null) : null;
  const match = readable ? await findMasterMatch(shopId, fields) : null;

  const aiFields: Record<string, unknown> = {
    ...Object.fromEntries(AI_FIELD_KEYS.map((k) => [k, fields[k]])),
    descriptionEn: read?.descriptionEn?.trim() ?? "",
    descriptionLocal: read?.descriptionLocal?.trim() ?? "",
    specsEn: read?.specsEn ?? [],
    specsLocal: read?.specsLocal ?? [],
    categoryId,
    match,
  };
  const expires = new Date(Date.now() + rule.photoRetentionDays * 86_400_000);
  const row = await db.transaction(async (tx) => {
    const [draft] = await tx
      .insert(shopPhotoListings)
      .values({
        shopId,
        createdBy: actor.id,
        status: readable ? "DRAFT" : "UNREADABLE",
        unreadableReason,
        photoCount: prepared.length,
        localLang,
        aiModel: result.model,
        aiFields,
        matchType: match?.reason ?? null,
        matchProductId: match?.productId ?? null,
        matchScore: match?.score ?? null,
        photosExpireAt: expires,
      })
      .returning();
    await tx.insert(shopPhotoListingPhotos).values(
      prepared.map((p, i) => ({ listingId: draft.id, position: i, side: p.side, contentType: "image/jpeg", sizeBytes: p.bytes.length, data: p.bytes })),
    );
    return draft;
  });
  return toView(row, rule.lowConfidenceBelow);
}

/* ------------------------------------------------------------ drafts */

async function loadDraft(shopId: string, draftId: string, client: DbClient = db): Promise<ShopPhotoListing> {
  const [row] = await client
    .select()
    .from(shopPhotoListings)
    .where(and(eq(shopPhotoListings.id, draftId), eq(shopPhotoListings.shopId, shopId)));
  if (!row) throw notFound("Product photo");
  return row;
}

export async function getPhotoListingDraft(shopId: string, actor: PhotoListingActor, draftId: string): Promise<PhotoListingDraftView> {
  await assertPhotoListingAccess(shopId, actor);
  const rule = await getRule("smartShopping");
  return toView(await loadDraft(shopId, draftId), rule.lowConfidenceBelow);
}

/** Open drafts of the shop, newest first: the bulk review list ("review them all at the end"). */
export async function listPhotoListingDrafts(shopId: string, actor: PhotoListingActor): Promise<PhotoListingDraftView[]> {
  await assertPhotoListingAccess(shopId, actor);
  const rule = await getRule("smartShopping");
  const rows = await db
    .select()
    .from(shopPhotoListings)
    .where(and(eq(shopPhotoListings.shopId, shopId), inArray(shopPhotoListings.status, ["DRAFT", "UNREADABLE"]), isNull(shopPhotoListings.photosDeletedAt)))
    .orderBy(desc(shopPhotoListings.createdAt))
    .limit(50);
  return Promise.all(rows.map((r) => toView(r, rule.lowConfidenceBelow)));
}

/** Drops a draft and its photos now (the owner's "Discard"). */
export async function discardPhotoListingDraft(shopId: string, actor: PhotoListingActor, draftId: string): Promise<void> {
  await assertPhotoListingAccess(shopId, actor);
  const draft = await loadDraft(shopId, draftId);
  if (draft.status === "PUBLISHED") throw conflict("This product is already published.");
  await db.transaction(async (tx) => {
    await tx.delete(shopPhotoListingPhotos).where(eq(shopPhotoListingPhotos.listingId, draft.id));
    await tx
      .update(shopPhotoListings)
      .set({ status: "DISCARDED", photosDeletedAt: new Date(), updatedAt: new Date() })
      .where(eq(shopPhotoListings.id, draft.id));
  });
}

/** A draft photo's bytes, for the review screen (the shop's owner only). */
export async function readPhotoListingPhoto(shopId: string, actor: PhotoListingActor, draftId: string, photoId: string): Promise<{ bytes: Buffer; contentType: string }> {
  await assertPhotoListingAccess(shopId, actor);
  const draft = await loadDraft(shopId, draftId);
  const [photo] = await db
    .select({ data: shopPhotoListingPhotos.data, contentType: shopPhotoListingPhotos.contentType })
    .from(shopPhotoListingPhotos)
    .where(and(eq(shopPhotoListingPhotos.id, photoId), eq(shopPhotoListingPhotos.listingId, draft.id)));
  if (!photo) throw notFound("Photo");
  return { bytes: photo.data, contentType: photo.contentType };
}

/* ------------------------------------------------------------ 2. price and stock by voice */

export interface SpokenPriceStock {
  parse: PriceStockParse;
  /** "Price ₹60 per litre, stock 50" in English, Hindi and Marathi, for the screen and speech. */
  readBack: Record<"en" | "hi" | "mr", string>;
  /** AI filled what the deterministic reader missed. */
  aiUsed: boolean;
}

/**
 * The owner's sentence → price, stock and units. The deterministic reader first; AI (VOICE_PARSE) only for
 * the parts it could not find. AI being off or over its limit is not an error here: the owner types the rest.
 */
export async function parseSpokenPriceStock(shopId: string, actor: PhotoListingActor, text: string): Promise<SpokenPriceStock> {
  await assertPhotoListingAccess(shopId, actor);
  const clean = text.trim().slice(0, 500);
  let parse = parsePriceStock(clean);
  let aiUsed = false;
  if (!parse.complete && /\p{L}|\p{N}/u.test(clean)) {
    try {
      const ai = await runAi(
        { feature: "VOICE_PARSE", userId: actor.id, shopId },
        { text: clean, instructions: VOICE_INSTRUCTIONS, schema: voiceSchema, maxTokens: 500 },
      );
      const o = ai.output;
      if (o) {
        const merged: PriceStock = {
          pricePaise: parse.pricePaise ?? (o.priceRupees != null && o.priceRupees > 0 ? Math.round(o.priceRupees * 100) : null),
          priceUnit: parse.priceUnit ?? o.priceUnit,
          stock: parse.stock ?? (o.stock != null && o.stock >= 0 ? o.stock : null),
          stockUnit: parse.stockUnit ?? o.stockUnit ?? o.priceUnit,
          customUnit: parse.customUnit ?? o.customUnit?.trim() ?? null,
          stockWord: parse.stockWord,
        };
        aiUsed = merged.pricePaise !== parse.pricePaise || merged.stock !== parse.stock || merged.priceUnit !== parse.priceUnit;
        const missing: ("price" | "stock")[] = [];
        if (merged.pricePaise === null) missing.push("price");
        if (merged.stock === null) missing.push("stock");
        parse = { ...merged, complete: missing.length === 0, missing };
      }
    } catch (error) {
      if (!(error instanceof AiUnavailableError) && !(error instanceof AppError && error.code === "RATE_LIMITED")) throw error;
    }
  }
  return { parse, readBack: { en: readBack(parse, "en"), hi: readBack(parse, "hi"), mr: readBack(parse, "mr") }, aiUsed };
}

/* ------------------------------------------------------------ 3–4. publish */

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const publishInputSchema = z.object({
  fields: z.object({
    brand: optText(120),
    name: z.string().trim().min(2, "Product name must be at least 2 characters.").max(200),
    variant: optText(120),
    packSize: z.number().positive().max(1_000_000).nullish().transform((v) => v ?? null),
    packUnit: optText(20),
    mrpRupees: z.number().positive().max(MAX_PRICE_PAISE / 100).nullish().transform((v) => v ?? null),
    categoryId: z.string().uuid().nullish().transform((v) => v ?? null),
    subCategory: optText(120),
    barcode: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z]{6,32}$/, "Barcode: 6–32 digits or letters")
      .nullish()
      .or(z.literal(""))
      .transform((v) => v || null),
    fssaiNumber: optText(40),
    ingredients: optText(1000),
    vegMark: z.enum(["VEG", "NON_VEG", "NONE"]).nullish().transform((v) => v ?? null),
    manufacturer: optText(200),
    expiry: optText(60),
    descriptionEn: optText(1000),
    descriptionLocal: optText(1000),
    specsEn: z.array(z.string().trim().max(200)).max(12).default([]),
    specsLocal: z.array(z.string().trim().max(200)).max(12).default([]),
  }),
  price: z.object({
    pricePaise: z.number().int().positive().max(MAX_PRICE_PAISE).nullable(),
    priceUnit: z.enum(SELLING_UNITS),
    stock: z.number().min(0).max(1_000_000).nullable(),
    stockUnit: z.enum(SELLING_UNITS).nullable(),
    customUnit: optText(30),
    voiceText: optText(500),
  }),
  /** The suggested master product the owner accepted; null = create a new product. */
  matchProductId: z.string().uuid().nullable().default(null),
  /** Which draft photos become the product's photos (first = main). */
  photoIds: z.array(z.string().uuid()).max(4).default([]),
  /** Create it even though a similarly named product exists (after the duplicate warning). */
  confirmDuplicate: z.boolean().default(false),
});
export type PublishInput = z.input<typeof publishInputSchema>;

export interface PublishResult {
  outcome: PhotoListingOutcome;
  productId: string;
  shopProductId: string;
  /** PENDING_APPROVAL for a new product of a shop owner: it is in this shop now, other shops after review. */
  approvalStatus: Product["approvalStatus"];
  pendingPriceRequestId: string | null;
  pricePaise: number | null;
  stock: number | null;
  photosAdded: number;
  photoErrors: string[];
  notes: string[];
}

const rupeesText = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return v.map(norm).join("|");
  return String(v).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Fields the AI filled that the owner kept, and fields the owner changed (or added). */
export function compareAiToPublished(ai: Record<AiFieldKey, AiFieldView>, published: Record<AiFieldKey, unknown>): { kept: AiFieldKey[]; changed: AiFieldKey[] } {
  const kept: AiFieldKey[] = [];
  const changed: AiFieldKey[] = [];
  for (const key of AI_FIELD_KEYS) {
    const a = norm(ai[key]?.value);
    const p = norm(published[key]);
    if (!a && !p) continue;
    if (a === p) kept.push(key);
    else changed.push(key);
  }
  return { kept, changed };
}

/** Net quantity as the catalogue keeps it: a whole number of g / ml / piece (1.5 kg → 1500 g). */
function netQuantityOf(size: number | null, unit: string | null): { netQuantity: number; netQuantityUnit: string } | null {
  const base = labelPackInBase(size, unit);
  if (!base || !Number.isInteger(Math.round(base.amount * 1000) / 1000) || base.amount > 2_000_000_000) return null;
  return { netQuantity: Math.round(base.amount), netQuantityUnit: base.unit };
}

/**
 * "Publish to my shop": links the matched master product or creates a new one (pending review), sets the shop's
 * price, stock and unit, adds the chosen photos through the photo pipeline and records AI-vs-published.
 * A price above the MRP read from the pack is refused (PRICE_ABOVE_MRP) — the owner lowers the price or corrects
 * a misread MRP.
 */
export async function publishPhotoListing(shopId: string, actor: PhotoListingActor, draftId: string, rawInput: PublishInput): Promise<PublishResult> {
  const { shop, isOwner } = await assertPhotoListingAccess(shopId, actor);
  const input = publishInputSchema.parse(rawInput);
  const draft = await loadDraft(shopId, draftId);
  if (draft.status === "PUBLISHED") throw conflict("This product is already published.");
  if (draft.status !== "DRAFT") throw conflict("This photo could not be read. Take the photos again.", { reason: "UNREADABLE" });
  const ai = fieldsOf(draft.aiFields as Record<string, unknown> | null);
  const f = input.fields;
  const notes: string[] = [];

  // The matched master product (only the one suggested for these photos).
  let master: Product | null = null;
  if (input.matchProductId) {
    if (input.matchProductId !== draft.matchProductId) throw validationFailed("Choose the suggested product, or add it as a new product.");
    master = (await db.query.products.findFirst({ where: and(eq(products.id, input.matchProductId), isNull(products.deletedAt)) })) ?? null;
    if (!master || master.approvalStatus === "REJECTED" || !master.isActive) throw conflict("That catalogue product is no longer available. Add it as a new product.");
  }

  const said: PriceStock = {
    pricePaise: input.price.pricePaise,
    priceUnit: input.price.priceUnit,
    stock: input.price.stock,
    stockUnit: input.price.stockUnit ?? input.price.priceUnit,
    customUnit: input.price.customUnit,
    stockWord: null,
  };
  const existingPack = master ? packInBase(master.unit, master.unitSizeMilli) : null;
  const q = toListingQuantities(said, { size: f.packSize, unit: packUnitFromLabel(f.packUnit) }, existingPack);
  notes.push(...q.notes);
  if (master && !existingPack) notes.push("The catalogue product's unit could not be compared; the price and stock were used as said.");

  const loose = master ? master.kind === "LOOSE" : q.loose && !f.barcode && f.mrpRupees === null;
  if (q.pricePaise === null && !loose) {
    throw validationFailed("Say or type the selling price. Only loose goods (sold by weight or volume) may be listed without a price.", { reason: "PRICE_REQUIRED" });
  }
  if (q.pricePaise !== null && (q.pricePaise < 1 || q.pricePaise > MAX_PRICE_PAISE)) throw validationFailed("The price of one unit must be between ₹0.01 and ₹10,00,000.");

  // MRP read from the pack (as corrected by the owner), else the master's.
  const mrpPaise = f.mrpRupees !== null ? Math.round(f.mrpRupees * 100) : (master?.mrpPaise ?? null);
  if (priceAboveMrp(q.pricePaise, mrpPaise)) {
    throw conflict(
      `Your price ${rupeesText(q.pricePaise!)} is above the MRP ${rupeesText(mrpPaise!)} printed on the pack. Lower the price, or correct the MRP if it was read wrong.`,
      { reason: "PRICE_ABOVE_MRP", pricePaise: q.pricePaise, mrpPaise },
    );
  }

  const immediate = appliesImmediately(actor, shop.ownerId);
  const cActor = catalogueActor(actor, isOwner);
  const price = q.pricePaise;
  const onSale = immediate && price !== null;
  const attributes = {
    photoListing: {
      draftId: draft.id,
      brand: f.brand,
      fssaiNumber: f.fssaiNumber,
      ingredients: f.ingredients,
      vegMark: f.vegMark,
      expiry: f.expiry,
      sellingUnit: input.price.priceUnit,
      customUnit: input.price.customUnit,
      descriptionLocal: f.descriptionLocal,
      specsLocal: f.specsLocal,
    },
  };
  const categoryName = f.categoryId
    ? ((await db.select({ name: productCategories.name }).from(productCategories).where(eq(productCategories.id, f.categoryId)))[0]?.name ?? null)
    : null;
  if (f.categoryId && !categoryName) throw validationFailed("Choose a category from the list.");
  const brandId = master ? null : await resolveBrandId(f.brand);

  const description = [f.descriptionEn, f.descriptionLocal].filter(Boolean).join("\n\n") || null;
  const specs = [...f.specsEn, ...(f.specsLocal.length ? ["", ...f.specsLocal] : [])].join("\n").trim() || null;
  const title = [f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? f.brand : null, f.name, f.variant, f.packSize && f.packUnit ? `${f.packSize} ${f.packUnit}` : null]
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);

  const result = await db.transaction(async (tx) => {
    let outcome: PhotoListingOutcome;
    let product: Product;
    let shopProductId: string;
    if (master) {
      product = master;
      const listed = await listingOf(shopId, master.id, tx);
      if (listed) {
        shopProductId = listed.id;
        outcome = "UPDATED_LISTING";
        if (immediate && price !== null) {
          await updateShopProduct(listed.id, { onlinePricePaise: price, offlinePricePaise: price, onlineSaleEnabled: true, offlineSaleEnabled: true }, cActor, tx);
        }
      } else {
        await addCategoryToShop(shopId, master.categoryId, cActor, { reason: "photo_listing" }, tx);
        const created = await createShopProduct(
          {
            shopId,
            productId: master.id,
            onlinePricePaise: immediate ? price : null,
            offlinePricePaise: immediate ? price : null,
            onlineSaleEnabled: onSale,
            offlineSaleEnabled: onSale,
          },
          cActor,
          tx,
        );
        shopProductId = created.id;
        outcome = "LINKED_MASTER";
      }
    } else {
      const created = await createProductForShop(
        {
          shopId,
          categoryId: f.categoryId,
          name: title || f.name,
          description,
          specifications: specs,
          subCategory: f.subCategory,
          unit: q.unit,
          unitSizeMilli: q.unitSizeMilli,
          onlinePricePaise: price,
          offlinePricePaise: price,
          onlineSaleEnabled: price !== null,
          offlineSaleEnabled: price !== null,
          confirmDuplicate: input.confirmDuplicate,
          barcode: f.barcode,
        },
        cActor,
        immediate,
        tx,
      );
      product = created.product;
      shopProductId = created.shopProduct.id;
      if (created.reusedExisting) {
        outcome = "REUSED_EXISTING";
      } else {
        outcome = created.product.approvalStatus === "PENDING_APPROVAL" ? "CREATED_PENDING" : "CREATED_APPROVED";
        // The label's details on the new product (it waits for review, so our team checks them).
        const net = netQuantityOf(f.packSize, f.packUnit);
        const [updated] = await tx
          .update(products)
          .set({
            kind: loose ? "LOOSE" : "PACKAGED",
            brandId,
            variant: f.variant,
            manufacturerName: f.manufacturer,
            ...(net ?? {}),
            ...(mrpPaise !== null ? { mrpPaise, mrpSource: "SELLER_SUBMITTED" as const } : {}),
          })
          .where(eq(products.id, created.product.id))
          .returning();
        product = updated;
      }
    }

    // A shop's MRP that differs from the master's applies to this shop only (as in the bulk upload).
    const shopMrp = master && mrpPaise !== null && mrpPaise !== master.mrpPaise ? mrpPaise : null;
    const [details] = await tx.select().from(shopListingDetails).where(eq(shopListingDetails.shopProductId, shopProductId));
    const mergedAttributes = { ...((details?.attributes as Record<string, unknown>) ?? {}), ...attributes };
    if (details) {
      await tx
        .update(shopListingDetails)
        .set({ attributes: mergedAttributes, ...(shopMrp !== null ? { mrpPaise: shopMrp } : {}), updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(shopListingDetails.shopProductId, shopProductId));
    } else {
      await tx.insert(shopListingDetails).values({ shopProductId, shopId, attributes: mergedAttributes, mrpPaise: shopMrp, updatedBy: actor.id });
    }
    if (shopMrp !== null) notes.push(`MRP ${rupeesText(shopMrp)} saved for your shop only (the catalogue shows ${master?.mrpPaise != null ? rupeesText(master.mrpPaise) : "none"}).`);

    // Stock, through the listing update so the stock ledger records it.
    if (q.stock !== null && q.stock > 0) await updateShopProduct(shopProductId, { onlineStock: q.stock }, cActor, tx);

    // Someone other than the owner (without override): the price waits for the owner's approval.
    let pendingPriceRequestId: string | null = null;
    if (!immediate && price !== null) {
      const changes: ProposedChange[] = [
        { shopProductId, priceType: "ONLINE", proposedPricePaise: price },
        { shopProductId, priceType: "OFFLINE", proposedPricePaise: price },
      ];
      const { batch } = await submitPriceRequests({ shopId, changes, note: `Price for "${product.name}" (added by photo)` }, actor, tx);
      pendingPriceRequestId = batch.id;
    }

    const published: Record<AiFieldKey, unknown> = {
      brand: f.brand,
      name: f.name,
      variant: f.variant,
      packSize: f.packSize,
      packUnit: f.packUnit,
      mrpRupees: f.mrpRupees,
      category: categoryName,
      subCategory: f.subCategory,
      barcode: f.barcode,
      fssaiNumber: f.fssaiNumber,
      ingredients: f.ingredients,
      vegMark: f.vegMark,
      manufacturer: f.manufacturer,
      expiry: f.expiry,
    };
    const { kept, changed } = compareAiToPublished(ai, published);
    const aiText = (draft.aiFields ?? {}) as Record<string, unknown>;
    const textChanged = TEXT_KEYS.filter((k) => norm(aiText[k]) !== norm(f[k]));
    await tx
      .update(shopPhotoListings)
      .set({
        status: "PUBLISHED",
        publishedFields: { ...published, descriptionEn: f.descriptionEn, descriptionLocal: f.descriptionLocal, specsEn: f.specsEn, specsLocal: f.specsLocal, textChanged },
        changedFields: changed,
        fieldsKept: kept.length,
        fieldsChanged: changed.length,
        outcome,
        productId: product.id,
        shopProductId,
        pricePaise: price,
        priceUnit: input.price.priceUnit,
        stock: q.stock === null ? null : String(q.stock),
        stockUnit: input.price.stockUnit,
        customUnit: input.price.customUnit,
        voiceText: input.price.voiceText,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopPhotoListings.id, draft.id));
    return { outcome, product, shopProductId, pendingPriceRequestId };
  });

  // After commit: the chosen photos through the product photo pipeline, then their draft copies go.
  const photoErrors: string[] = [];
  let photosAdded = 0;
  const chosen = input.photoIds.length
    ? await db
        .select()
        .from(shopPhotoListingPhotos)
        .where(and(eq(shopPhotoListingPhotos.listingId, draft.id), inArray(shopPhotoListingPhotos.id, input.photoIds)))
    : [];
  const ordered = input.photoIds.map((id) => chosen.find((p) => p.id === id)).filter((p): p is (typeof chosen)[number] => Boolean(p));
  for (const photo of ordered) {
    try {
      await uploadListingPhoto(shopId, result.shopProductId, photo.data, { ...cActor, via: isOwner ? "OWNER" : "SUPPORT" }, { source: "photo_listing", draftId: draft.id, side: photo.side });
      photosAdded++;
      await db.delete(shopPhotoListingPhotos).where(eq(shopPhotoListingPhotos.id, photo.id));
    } catch (error) {
      photoErrors.push(error instanceof Error ? error.message : "The photo could not be added.");
    }
  }
  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(shopPhotoListingPhotos).where(eq(shopPhotoListingPhotos.listingId, draft.id));
  if ((left?.n ?? 0) === 0) await db.update(shopPhotoListings).set({ photosDeletedAt: new Date() }).where(eq(shopPhotoListings.id, draft.id));
  await checkCommissionMilestonesSafely(shopId);

  return {
    outcome: result.outcome,
    productId: result.product.id,
    shopProductId: result.shopProductId,
    approvalStatus: result.product.approvalStatus,
    pendingPriceRequestId: result.pendingPriceRequestId,
    pricePaise: price,
    stock: q.stock,
    photosAdded,
    photoErrors,
    notes,
  };
}

/* ------------------------------------------------------------ retention */

/**
 * Daily: deletes the photos of drafts past smartShopping.photoRetentionDays (photos the AI read but that were
 * not used — used ones were moved into the product photo pipeline at publish), and closes drafts left open.
 * The rows stay (without photos) for the accuracy report.
 */
export async function purgeExpiredPhotoListingPhotos(now = new Date()): Promise<{ drafts: number; photos: number }> {
  const expired = await db
    .select({ id: shopPhotoListings.id, status: shopPhotoListings.status })
    .from(shopPhotoListings)
    .where(and(isNull(shopPhotoListings.photosDeletedAt), lte(shopPhotoListings.photosExpireAt, now)))
    .limit(500);
  if (expired.length === 0) return { drafts: 0, photos: 0 };
  const ids = expired.map((e) => e.id);
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(shopPhotoListingPhotos).where(inArray(shopPhotoListingPhotos.listingId, ids)).returning({ id: shopPhotoListingPhotos.id });
    await tx.update(shopPhotoListings).set({ photosDeletedAt: now, updatedAt: now }).where(inArray(shopPhotoListings.id, ids));
    await tx
      .update(shopPhotoListings)
      .set({ status: "DISCARDED" })
      .where(and(inArray(shopPhotoListings.id, ids), inArray(shopPhotoListings.status, ["DRAFT", "UNREADABLE"])));
    return { drafts: ids.length, photos: deleted.length };
  });
}

/* ------------------------------------------------------------ admin report */

export interface PhotoListingReport {
  since: Date;
  shots: number;
  unreadable: number;
  published: number;
  byOutcome: Record<string, number>;
  /** Of the fields the AI filled or the owner set on published products. */
  fieldsKept: number;
  fieldsChanged: number;
  /** kept / (kept + changed), 0–100; null with nothing published. */
  accuracyPct: number | null;
  changedByField: { field: string; changed: number }[];
  shops: number;
  aiCalls: number;
  aiCostMicros: number;
}

/** "Products added by photo" and AI accuracy over the last `days` days (admin dashboard). */
export async function photoListingReport(days = 30): Promise<PhotoListingReport> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [totals] = await db
    .select({
      shots: sql<number>`count(*)::int`,
      unreadable: sql<number>`count(*) FILTER (WHERE ${shopPhotoListings.status} = 'UNREADABLE')::int`,
      published: sql<number>`count(*) FILTER (WHERE ${shopPhotoListings.status} = 'PUBLISHED')::int`,
      kept: sql<number>`coalesce(sum(${shopPhotoListings.fieldsKept}) FILTER (WHERE ${shopPhotoListings.status} = 'PUBLISHED'), 0)::int`,
      changed: sql<number>`coalesce(sum(${shopPhotoListings.fieldsChanged}) FILTER (WHERE ${shopPhotoListings.status} = 'PUBLISHED'), 0)::int`,
      shops: sql<number>`count(DISTINCT ${shopPhotoListings.shopId}) FILTER (WHERE ${shopPhotoListings.status} = 'PUBLISHED')::int`,
    })
    .from(shopPhotoListings)
    .where(gte(shopPhotoListings.createdAt, since));
  const outcomes = await db
    .select({ outcome: shopPhotoListings.outcome, n: sql<number>`count(*)::int` })
    .from(shopPhotoListings)
    .where(and(eq(shopPhotoListings.status, "PUBLISHED"), gte(shopPhotoListings.createdAt, since)))
    .groupBy(shopPhotoListings.outcome);
  const fieldRows = (await db.execute(sql`
    SELECT f AS field, count(*)::int AS changed
    FROM ${shopPhotoListings}, unnest(${shopPhotoListings.changedFields}) AS f
    WHERE ${shopPhotoListings.status} = 'PUBLISHED' AND ${shopPhotoListings.createdAt} >= ${since.toISOString()}::timestamptz
    GROUP BY f ORDER BY 2 DESC`)) as unknown as { field: string; changed: number }[];
  const [ai] = await db
    .select({ calls: sql<number>`count(*)::int`, cost: sql<number>`coalesce(sum(${aiUsageLog.costMicros}), 0)::bigint` })
    .from(aiUsageLog)
    .where(and(inArray(aiUsageLog.feature, ["PRODUCT_PHOTO", "VOICE_PARSE"]), gte(aiUsageLog.createdAt, since), sql`${aiUsageLog.shopId} IS NOT NULL`));
  const kept = totals?.kept ?? 0;
  const changed = totals?.changed ?? 0;
  return {
    since,
    shots: totals?.shots ?? 0,
    unreadable: totals?.unreadable ?? 0,
    published: totals?.published ?? 0,
    byOutcome: Object.fromEntries(outcomes.map((o) => [o.outcome ?? "UNKNOWN", o.n])),
    fieldsKept: kept,
    fieldsChanged: changed,
    accuracyPct: kept + changed > 0 ? Math.round((kept * 1000) / (kept + changed)) / 10 : null,
    changedByField: fieldRows.map((r) => ({ field: r.field, changed: Number(r.changed) })),
    shops: totals?.shops ?? 0,
    aiCalls: ai?.calls ?? 0,
    aiCostMicros: Number(ai?.cost ?? 0),
  };
}
