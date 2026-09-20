/**
 * Request schemas for the product-master API (Zod). Unknown keys are rejected so a
 * mistyped field name fails loudly instead of silently importing nothing.
 */
import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).nullish();
const money = z.union([z.number().finite().min(0).max(1e9), z.string().trim().max(40)]).nullish();

export const stagedOfferSchema = z
  .object({
    sellerId: text(120),
    sellerName: text(200),
    sellerLocation: text(200),
    sellerRating: z.union([z.number().min(0).max(5), z.string().trim().max(10)]).nullish(),
    price: money,
    mrp: money,
    currency: text(3),
    stock: text(60),
    deliveryInformation: text(300),
    url: z.string().trim().url().max(1000).nullish(),
    collectedAt: z.union([z.string().trim().max(40), z.date()]).nullish(),
    taxInclusive: z.boolean().nullish(),
  })
  .strict();

export const stagedAttributeSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    value: z.union([z.string().max(4000), z.number().finite(), z.boolean()]),
    unit: text(30),
    original: text(500),
  })
  .strict();

export const stagedProductSchema = z
  .object({
    sourceProductId: z.string().trim().min(1).max(200),
    sourceUrl: z.string().trim().url().max(1000).nullish(),
    name: text(500),
    brand: text(300),
    manufacturer: text(300),
    categories: z.array(z.string().trim().max(200)).max(20).optional(),
    description: text(20000),
    shortDescription: text(1000),
    gtin: text(40),
    isbn: text(40),
    mpn: text(120),
    model: text(120),
    sku: text(120),
    productCode: text(120),
    quantityText: text(120),
    netWeightText: text(60),
    grossWeightText: text(60),
    dimensionsText: text(120),
    color: text(120),
    size: text(60),
    material: text(200),
    shape: text(120),
    variant: text(200),
    gstRate: z.union([z.string().trim().max(30), z.number()]).nullish(),
    hsnCode: z.union([z.string().trim().max(20), z.number()]).nullish(),
    cess: z.union([z.string().trim().max(30), z.number()]).nullish(),
    countryOfOrigin: text(120),
    attributes: z.array(stagedAttributeSchema).max(200).optional(),
    images: z.array(z.string().trim().url().max(1000)).max(10).optional(),
    rating: z.number().min(0).max(5).nullish(),
    reviewCount: z.number().int().min(0).nullish(),
    availability: text(120),
    offer: stagedOfferSchema.nullish(),
    keywords: z.array(z.string().trim().max(80)).max(50).optional(),
    sourceConfidence: z.number().min(0).max(100).nullish(),
  })
  .strict();

export const importBodySchema = z.object({
  /** Up to 1,000 records per call; larger loads use a source adapter or the CLI. */
  rows: z.array(stagedProductSchema).min(1).max(1000),
});

export const matchBodySchema = z.object({ product: stagedProductSchema });
export const validateBodySchema = z.object({ product: stagedProductSchema });

export const listQuerySchema = z.object({
  brand: z.string().regex(/^GKS-BRND-\d{9}$/).optional(),
  manufacturer: z.string().regex(/^GKS-MFR-\d{9}$/).optional(),
  category: z.string().max(200).optional(),
  status: z.enum(["ACTIVE", "OUT_OF_STOCK", "DISCONTINUED", "TEMPORARILY_UNAVAILABLE", "UNKNOWN"]).optional(),
  minQuality: z.coerce.number().min(0).max(100).optional(),
  hasGtin: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  brand: z.string().regex(/^GKS-BRND-\d{9}$/).optional(),
  category: z.string().max(200).optional(),
  manufacturer: z.string().regex(/^GKS-MFR-\d{9}$/).optional(),
  status: z.enum(["ACTIVE", "OUT_OF_STOCK", "DISCONTINUED", "TEMPORARILY_UNAVAILABLE", "UNKNOWN"]).optional(),
  minQuality: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const pageQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});

export const priceHistoryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

export const decisionBodySchema = z.object({
  decision: z.enum(["CONFIRMED_SAME", "CONFIRMED_DIFFERENT", "SAME_FAMILY"]),
  note: z.string().trim().max(500).nullish(),
});

export const promoteBodySchema = z.object({
  minQuality: z.number().min(0).max(100).optional(),
  note: z.string().trim().max(500).nullish(),
});

export const MASTER_ID = /^GKS-PROD-\d{9}$/;
