/**
 * Customer barcode search (docs/search-brand-barcode-favourites-2026-11, flag
 * brand_barcode_favourites_enabled): a customer scans or types the barcode on a pack and gets the
 * catalogue product(s) with that code — name, brand, pack size, MRP — and, when a delivery location is
 * known, the lowest price and number of shops near them.
 *
 * Read-only, public. Only approved, active catalogue products are returned (a shop owner's own product
 * waiting for review is not shown to customers). A code shared by several products — a GTIN reused
 * after delisting, or the same code in `gtin` and another product's local `barcode` — returns all of
 * them (at most 10), approved best matches first; the customer picks.
 *
 * The shop owner's lookup (services/barcode-lookup.ts) is separate and unchanged.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { formatQuantity } from "@/lib/money";
import { gtinLookupForms, validateRetailBarcode, type RetailBarcodeFormat, type RetailBarcodeResult } from "@/lib/retail-barcode";
import { db } from "@/server/db";
import { brands, productCategories, products } from "@/server/db/schema";
import { lowestOffersForProducts } from "./catalogue";

export const BARCODE_MAX_MATCHES = 10;

export interface BarcodeProductMatch {
  productId: string;
  name: string;
  brandName: string | null;
  /** The brand's page (/brand/[slug]) when it has one. */
  brandSlug: string | null;
  categoryName: string;
  imageUrl: string | null;
  /** Printed net quantity ("500 g"), else the selling unit ("1 L"). */
  packSize: string;
  mrpPaise: number | null;
  /** The product page: every shop selling it. */
  href: string;
  /** Shops listing it anywhere (Live listings). */
  shopCount: number;
  /** Near the customer's delivery location; null when no location is set. */
  nearby: { shopCount: number; lowestPricePaise: number | null; buyable: boolean } | null;
}

export type BarcodeSearchResult =
  | Extract<RetailBarcodeResult, { ok: false }>
  | { ok: true; code: string; format: RetailBarcodeFormat; matches: BarcodeProductMatch[] };

export function packSizeText(p: { netQuantity: number | null; netQuantityUnit: string | null; unit: string; unitSizeMilli: number }): string {
  if (p.netQuantity != null && p.netQuantityUnit) return `${p.netQuantity} ${p.netQuantityUnit}`;
  return formatQuantity(p.unitSizeMilli, p.unit);
}

/**
 * Validates the code (EAN-8, UPC-A, EAN-13, GTIN-14 with a valid check digit) and looks it up.
 * `nearbyShopIds`: the shops delivering to the customer, when they have a location.
 */
export async function searchProductsByBarcode(raw: string, options: { nearbyShopIds?: readonly string[] } = {}): Promise<BarcodeSearchResult> {
  const valid = validateRetailBarcode(raw);
  if (!valid.ok) return valid;
  const forms = gtinLookupForms(valid.gtin14, valid.code);
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      gtin: products.gtin,
      brandName: brands.name,
      brandSlug: brands.slug,
      brandLive: sql<boolean>`(${brands.isActive} AND ${brands.deletedAt} IS NULL)`,
      categoryName: productCategories.name,
      imageUrl: products.imageUrl,
      netQuantity: products.netQuantity,
      netQuantityUnit: products.netQuantityUnit,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
      mrpPaise: products.mrpPaise,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(
      and(
        isNull(products.deletedAt),
        eq(products.isActive, true),
        eq(products.approvalStatus, "APPROVED"),
        or(inArray(products.gtin, forms), inArray(products.barcode, forms)),
      ),
    )
    // A GTIN match before a local-barcode match, then by name.
    .orderBy(asc(sql`CASE WHEN ${inArray(products.gtin, forms)} THEN 0 ELSE 1 END`), asc(products.name))
    .limit(BARCODE_MAX_MATCHES);
  if (rows.length === 0) return { ok: true, code: valid.code, format: valid.format, matches: [] };

  const ids = rows.map((r) => r.productId);
  const [everywhere, near] = await Promise.all([
    lowestOffersForProducts(ids),
    options.nearbyShopIds ? lowestOffersForProducts(ids, { shopIds: options.nearbyShopIds }) : Promise.resolve(null),
  ]);
  return {
    ok: true,
    code: valid.code,
    format: valid.format,
    matches: rows.map((r) => {
      const n = near?.get(r.productId);
      return {
        productId: r.productId,
        name: r.name,
        brandName: r.brandLive ? r.brandName : null,
        brandSlug: r.brandLive ? r.brandSlug : null,
        categoryName: r.categoryName,
        imageUrl: r.imageUrl,
        packSize: packSizeText(r),
        mrpPaise: r.mrpPaise,
        href: `/products/${r.productId}`,
        shopCount: everywhere.get(r.productId)?.shopCount ?? 0,
        nearby: near ? { shopCount: n?.shopCount ?? 0, lowestPricePaise: n?.onlinePricePaise ?? null, buyable: n?.buyable ?? false } : null,
      };
    }),
  };
}
