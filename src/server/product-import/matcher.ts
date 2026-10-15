/**
 * Finds the product a spreadsheet row means, for one shop
 * (docs/product-import-2026-10 §3). Order:
 *   1. the shop's own SKU (shop_listing_details.seller_sku), or the GoKesari
 *      product code (P00012) of one of the shop's listings;
 *   2. the barcode, against the master catalogue (GTIN, then plain barcode);
 *   3. Name + Brand (+ Size / Color) — an exact normalised match in the master
 *      catalogue (Pending products included, Rejected ones not);
 *   4. nothing — a new product.
 *
 * The index is loaded once per batch (only what the batch's rows can match),
 * and rows that create something register it, so a later row in the same file
 * finds the product an earlier row made.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { brands, productAttributes, products, shopListingDetails, shopProducts } from "@/server/db/schema";
import type { ImportFields } from "./fields";
import { gtinDigits, matchKey } from "./normalise";

export interface ListingRef {
  id: string;
  productId: string;
  onlineStock: number;
  deleted: boolean;
  isActive: boolean;
  sellerSku: string | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  /** Planned but not yet written (preview of a file that creates it in an earlier row). */
  virtual?: boolean;
}

export interface ProductRef {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  brand: string | null;
  variant: string | null;
  approvalStatus: string;
  virtual?: boolean;
}

export type MatchType = "SKU" | "BARCODE" | "NAME" | "NEW";

export interface Resolution {
  listing: ListingRef | null;
  product: ProductRef | null;
  matchType: MatchType;
}

const nameKey = (name: string | null | undefined, brand: string | null | undefined) => `${matchKey(name)}|${matchKey(brand)}`;

const gtin14Of = (digits: string | null): string | null => (digits && /^\d{8,14}$/.test(digits) ? digits.padStart(14, "0") : null);

export class CatalogueMatcher {
  private bySku = new Map<string, ListingRef>();
  private byCode = new Map<string, ListingRef>();
  private byProduct = new Map<string, ListingRef>();
  private byGtin = new Map<string, ProductRef>();
  private byBarcode = new Map<string, ProductRef>();
  private byName = new Map<string, ProductRef[]>();

  private constructor(readonly shopId: string) {}

  /** Loads the shop's listings and the master products the given rows could match. */
  static async load(shopId: string, rows: ImportFields[], client: DbClient = db): Promise<CatalogueMatcher> {
    const m = new CatalogueMatcher(shopId);
    const listings = await client
      .select({
        id: shopProducts.id,
        productId: shopProducts.productId,
        onlineStock: shopProducts.onlineStock,
        deletedAt: shopProducts.deletedAt,
        isActive: shopProducts.isActive,
        onlinePricePaise: shopProducts.onlinePricePaise,
        offlinePricePaise: shopProducts.offlinePricePaise,
        code: products.code,
        sellerSku: shopListingDetails.sellerSku,
      })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
      .where(eq(shopProducts.shopId, shopId));
    for (const l of listings) {
      const ref: ListingRef = {
        id: l.id,
        productId: l.productId,
        onlineStock: l.onlineStock,
        deleted: l.deletedAt != null,
        isActive: l.isActive,
        sellerSku: l.sellerSku,
        onlinePricePaise: l.onlinePricePaise,
        offlinePricePaise: l.offlinePricePaise,
      };
      m.byProduct.set(l.productId, ref);
      m.byCode.set(l.code.toUpperCase(), ref);
      if (l.sellerSku) m.bySku.set(l.sellerSku.toLowerCase(), ref);
    }

    const gtins = new Set<string>();
    const barcodes = new Set<string>();
    const names = new Set<string>();
    for (const r of rows) {
      if (r.gtin14) {
        gtins.add(gtinDigits(r.gtin14));
        gtins.add(r.gtin14);
      }
      if (r.barcode) barcodes.add(r.barcode.trim());
      if (r.name) names.add(r.name.trim().toLowerCase());
    }
    const conditions = [];
    if (gtins.size) conditions.push(inArray(products.gtin, [...gtins]));
    if (barcodes.size) conditions.push(inArray(products.barcode, [...barcodes]));
    if (names.size) conditions.push(inArray(sql`lower(trim(${products.name}))`, [...names]));
    if (conditions.length) {
      const found = await client
        .select({
          id: products.id,
          code: products.code,
          name: products.name,
          categoryId: products.categoryId,
          gtin: products.gtin,
          barcode: products.barcode,
          variant: products.variant,
          approvalStatus: products.approvalStatus,
          brandName: brands.name,
          importedBrand: sql<string | null>`${productAttributes.attributes} ->> '_brand'`,
        })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(productAttributes, eq(productAttributes.productId, products.id))
        .where(
          and(
            isNull(products.deletedAt),
            ne(products.approvalStatus, "REJECTED"),
            sql`(${sql.join(conditions, sql` OR `)})`,
          ),
        );
      for (const p of found) {
        m.addProduct(
          {
            id: p.id,
            code: p.code,
            name: p.name,
            categoryId: p.categoryId,
            brand: p.brandName ?? p.importedBrand,
            variant: p.variant,
            approvalStatus: p.approvalStatus,
          },
          { gtin: p.gtin, barcode: p.barcode },
        );
      }
    }
    return m;
  }

  addProduct(p: ProductRef, ids: { gtin?: string | null; barcode?: string | null }): void {
    const g = gtin14Of(ids.gtin ?? null);
    if (g && !this.byGtin.has(g)) this.byGtin.set(g, p);
    if (ids.barcode) this.byBarcode.set(ids.barcode.trim().toUpperCase(), p);
    const key = nameKey(p.name, p.brand);
    const list = this.byName.get(key) ?? [];
    list.push(p);
    this.byName.set(key, list);
  }

  addListing(l: ListingRef): void {
    this.byProduct.set(l.productId, l);
    if (l.sellerSku) this.bySku.set(l.sellerSku.toLowerCase(), l);
  }

  setSku(l: ListingRef, sku: string): void {
    l.sellerSku = sku;
    this.bySku.set(sku.toLowerCase(), l);
  }

  listingBySku(sku: string): ListingRef | null {
    return this.bySku.get(sku.trim().toLowerCase()) ?? null;
  }

  listingForProduct(productId: string): ListingRef | null {
    return this.byProduct.get(productId) ?? null;
  }

  private byNameAndBrand(f: ImportFields): ProductRef | null {
    if (!f.name) return null;
    const candidates = this.byName.get(nameKey(f.name, f.brand)) ?? [];
    const wanted = [f.size, f.color].filter((v): v is string => Boolean(v)).map(matchKey);
    const fits = candidates.filter((p) => {
      if (wanted.length === 0) return true;
      const variant = matchKey(p.variant);
      return wanted.every((w) => variant.includes(w));
    });
    // Only an unambiguous match is a match.
    return fits.length === 1 ? fits[0] : null;
  }

  resolve(f: ImportFields): Resolution {
    let listing: ListingRef | null = null;
    if (f.sku) listing = this.listingBySku(f.sku);
    if (!listing && f.sku) listing = this.byCode.get(f.sku.trim().toUpperCase()) ?? null;
    if (!listing && f.productCode) listing = this.byCode.get(f.productCode.trim().toUpperCase()) ?? null;
    if (listing) return { listing, product: null, matchType: "SKU" };

    let product: ProductRef | null = null;
    let matchType: MatchType = "NEW";
    if (f.gtin14) product = this.byGtin.get(f.gtin14) ?? null;
    if (!product && f.barcode) product = this.byBarcode.get(f.barcode.trim().toUpperCase()) ?? null;
    if (product) matchType = "BARCODE";
    if (!product) {
      product = this.byNameAndBrand(f);
      if (product) matchType = "NAME";
    }
    if (product) return { listing: this.listingForProduct(product.id), product, matchType };
    return { listing: null, product: null, matchType: "NEW" };
  }
}
