/**
 * Barcode → catalogue product for a shop (onboarding Phase 2, WP2): the owner scans a pack and gets
 * the product to list, with its MRP. Reads `products` only — no product-master write, no admin
 * permission. A GTIN is matched in every form GoKesari stores (GTIN-14, EAN-13, UPC-A); any other
 * code against the shop-local `barcode` column.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/server/db";
import { productCategories, products, shopProducts } from "@/server/db/schema";
import { analyzeGtin } from "@/server/pmd/normalize/identifiers";
import { gtinForms } from "@/server/pmd/services/catalogue-bridge";

export interface BarcodeMatch {
  productId: string;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  unit: string;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
  /** Approved and on the catalogue; otherwise it is waiting for our team. */
  approved: boolean;
  /** The shop already lists it. */
  listed: boolean;
}

/** Digits and letters only, at most 32 — what a scanner or a typed number can be. */
export function cleanBarcode(raw: string): string | null {
  const code = raw.replace(/[^0-9A-Za-z]/g, "").slice(0, 32);
  return code.length >= 6 ? code : null;
}

export async function findProductByBarcode(shopId: string, raw: string): Promise<{ code: string; match: BarcodeMatch | null } | null> {
  const code = cleanBarcode(raw);
  if (!code) return null;
  const gtin = analyzeGtin(code);
  const forms = gtin ? [...new Set([...gtinForms(gtin.gtin14), code])] : [code];
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      categoryName: productCategories.name,
      imageUrl: products.imageUrl,
      unit: products.unit,
      kind: products.kind,
      mrpPaise: products.mrpPaise,
      approvalStatus: products.approvalStatus,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(and(isNull(products.deletedAt), eq(products.isActive, true), or(inArray(products.gtin, forms), eq(products.barcode, code))))
    .limit(5);
  // An approved product first; a pending one (an owner's own, waiting for review) only if none.
  const best = rows.find((r) => r.approvalStatus === "APPROVED") ?? rows[0];
  if (!best) return { code, match: null };
  const [listing] = await db
    .select({ id: shopProducts.id })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, best.productId), isNull(shopProducts.deletedAt)));
  return {
    code,
    match: {
      productId: best.productId,
      name: best.name,
      categoryName: best.categoryName,
      imageUrl: best.imageUrl,
      unit: best.unit,
      kind: best.kind,
      mrpPaise: best.mrpPaise,
      approved: best.approvalStatus === "APPROVED",
      listed: Boolean(listing),
    },
  };
}
