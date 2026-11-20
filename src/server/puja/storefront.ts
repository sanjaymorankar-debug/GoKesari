/**
 * Puja Samagri — customer side (docs/puja-samagri-2026-11).
 *
 *   - listings of the puja catalogue from approved shops, filtered by category, festival,
 *     price, loose / packed and in stock, searched in English, Hindi, Marathi and synonyms;
 *     ready puja kits and the live festival's items come first while a festival runs;
 *   - "price on confirmation": a loose or perishable listing the shop has not priced yet is
 *     shown with that label; the customer asks the shop, the shop answers with a price, the
 *     listing gets that price and goes in the cart like any other — so the cart, payment,
 *     cancellation, delivery and OTP flows are the existing ones, unchanged.
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  listingPriceRequests,
  productCatalogueAttrs,
  productCategories,
  productLocalNames,
  productPriceHistory,
  products,
  productSubcategories,
  shopListingDetails,
  shopProducts,
  shops,
  users,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { StorefrontProduct } from "@/server/services/catalogue";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { shopCarriesProductCategory } from "@/server/services/product-categories";

import { PUJA_SHOP_TYPE_KEY } from "./catalogue";
import { catalogueSearchCondition, type Actor } from "./service";

export interface PujaStorefrontFilters {
  q?: string | null;
  categoryId?: string | null;
  festival?: string | null;
  kind?: "loose" | "packed" | null;
  minPricePaise?: number | null;
  maxPricePaise?: number | null;
  inStock?: boolean;
  shopIds?: readonly string[] | null;
  shopId?: string | null;
  /** Festivals running now: their items (and the kits) are listed first. */
  liveFestivals?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface PujaListing extends StorefrontProduct {
  nameHi: string | null;
  nameMr: string | null;
  typeName: string | null;
  festivals: string[];
  perishable: boolean;
  /** No price yet and the item is loose or perishable: "Price on confirmation". */
  priceOnConfirmation: boolean;
}

const hasPrice = sql`(${shopProducts.onlinePricePaise} IS NOT NULL OR ${shopProducts.offlinePricePaise} IS NOT NULL)`;
const inStockSql = sql`(NOT ${shopProducts.trackInventory} OR ${shopProducts.onlineStock} > 0)`;
const pocSql = sql`(NOT ${hasPrice} AND (${products.kind} = 'LOOSE' OR COALESCE(${productCatalogueAttrs.isPerishable}, false)))`;

/** The listings a customer sees: live, priced listings, plus unpriced loose / perishable ones. */
function visibleConditions(f: PujaStorefrontFilters): SQL[] {
  const c: SQL[] = [
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    eq(shopProducts.isActive, true),
    isNull(shopProducts.deletedAt),
    eq(products.isActive, true),
    eq(productCategories.department, PUJA_SHOP_TYPE_KEY),
    shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
    sql`NOT ${shopProducts.ownerPaused}`,
    sql`${shopProducts.isAvailable}`,
    // Priced and on sale (the storefront's own rule), or waiting for a price.
    sql`((${hasPrice} AND (${shopProducts.onlineSaleEnabled} OR ${shopProducts.offlineSaleEnabled})) OR ${pocSql})`,
  ];
  if (f.inStock) c.push(inStockSql);
  if (f.categoryId) c.push(eq(products.categoryId, f.categoryId));
  if (f.festival) c.push(sql`${f.festival} = ANY(COALESCE(${productCatalogueAttrs.festivals}, '{}'::text[]))`);
  if (f.kind === "loose") c.push(eq(products.kind, "LOOSE"));
  if (f.kind === "packed") c.push(eq(products.kind, "PACKAGED"));
  if (f.minPricePaise != null) c.push(sql`COALESCE(${shopProducts.onlinePricePaise}, ${shopProducts.offlinePricePaise}) >= ${f.minPricePaise}`);
  if (f.maxPricePaise != null) c.push(sql`COALESCE(${shopProducts.onlinePricePaise}, ${shopProducts.offlinePricePaise}) <= ${f.maxPricePaise}`);
  if (f.shopIds) c.push(f.shopIds.length ? inArray(shopProducts.shopId, [...f.shopIds]) : sql`false`);
  if (f.shopId) c.push(eq(shopProducts.shopId, f.shopId));
  const search = catalogueSearchCondition(f.q);
  if (search) c.push(search);
  return c;
}

export async function listPujaStorefront(f: PujaStorefrontFilters): Promise<{ items: PujaListing[]; total: number }> {
  const live = [...(f.liveFestivals ?? [])];
  const festivalFirst = live.length
    ? sql`CASE WHEN ${productSubcategories.slug} = 'puja-type-puja-kit' THEN 0
               WHEN COALESCE(${productCatalogueAttrs.festivals}, '{}'::text[]) && ARRAY[${sql.join(live.map((x) => sql`${x}`), sql`, `)}]::text[] THEN 1
               ELSE 2 END`
    : null;
  const rows = await db
    .select({
      sp: shopProducts,
      product: products,
      category: productCategories,
      shop: shops,
      shopMrpPaise: shopListingDetails.mrpPaise,
      nameHi: productLocalNames.nameHi,
      nameMr: productLocalNames.nameMr,
      typeName: productSubcategories.name,
      festivals: productCatalogueAttrs.festivals,
      perishable: productCatalogueAttrs.isPerishable,
      total: sql<number>`count(*) OVER ()`.mapWith(Number),
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .leftJoin(productSubcategories, eq(productSubcategories.id, products.subcategoryId))
    .leftJoin(productLocalNames, eq(productLocalNames.productId, products.id))
    .leftJoin(productCatalogueAttrs, eq(productCatalogueAttrs.productId, products.id))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(and(...visibleConditions(f)))
    .orderBy(
      ...(festivalFirst ? [asc(festivalFirst)] : []),
      // Buyable first, then price on confirmation, then out of stock.
      sql`CASE WHEN ${hasPrice} AND ${inStockSql} THEN 0 WHEN NOT ${hasPrice} THEN 1 ELSE 2 END`,
      asc(productCategories.sortOrder),
      asc(products.name),
      asc(shopProducts.id),
    )
    .limit(Math.min(f.limit ?? 24, 100))
    .offset(f.offset ?? 0);
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => {
      const poc = r.sp.onlinePricePaise == null && r.sp.offlinePricePaise == null;
      return {
        shopProductId: r.sp.id,
        productId: r.product.id,
        productName: r.product.name,
        categoryName: r.category.name,
        categoryId: r.category.id,
        department: r.category.department,
        unit: r.product.unit,
        unitSizeMilli: r.product.unitSizeMilli,
        kind: r.product.kind,
        imageUrl: r.sp.imageUrl ?? r.product.imageUrl,
        onlinePricePaise: r.sp.onlinePricePaise,
        offlinePricePaise: r.sp.offlinePricePaise,
        onlineSaleEnabled: r.sp.onlineSaleEnabled,
        offlineSaleEnabled: r.sp.offlineSaleEnabled,
        isAvailable: r.sp.isAvailable,
        trackInventory: r.sp.trackInventory,
        onlineStock: r.sp.onlineStock,
        subscribable: r.product.subscribable,
        shopId: r.shop.id,
        shopName: r.shop.name,
        shopOwnerName: r.shop.ownerName,
        shopSlug: r.shop.slug,
        shopClassification: r.shop.classification,
        shortDescription: r.sp.shortDescription ?? null,
        // A shop's own MRP applies to that shop only.
        mrpPaise: r.shopMrpPaise ?? r.product.mrpPaise,
        nameHi: r.nameHi,
        nameMr: r.nameMr,
        typeName: r.typeName,
        festivals: r.festivals ?? [],
        perishable: r.perishable ?? false,
        priceOnConfirmation: poc,
      };
    }),
  };
}

/* ---------------------------------------------------------- price requests */

/** A customer asks the shop to price an unpriced loose / perishable listing. One open request per item. */
export async function requestListingPrice(customerId: string, shopProductId: string, input: { quantity?: number | null; note?: string | null }) {
  const [row] = await db
    .select({ sp: shopProducts, product: products, shop: shops, perishable: productCatalogueAttrs.isPerishable })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .leftJoin(productCatalogueAttrs, eq(productCatalogueAttrs.productId, products.id))
    .where(and(eq(shopProducts.id, shopProductId), isNull(shopProducts.deletedAt), eq(shopProducts.isActive, true)));
  if (!row || row.shop.status !== "APPROVED") throw notFound("Product");
  if (row.shop.ownerId === customerId) throw forbidden("This is your own shop's product.");
  if (row.sp.onlinePricePaise != null) throw conflict("This item already has a price — add it to your cart.");
  if (!(row.product.kind === "LOOSE" || row.perishable)) throw validationFailed("Only loose or fresh items are priced on request.");
  if (input.quantity != null && !(input.quantity > 0 && input.quantity <= 10_000)) throw validationFailed("Enter a sensible quantity.");

  const [existing] = await db
    .select()
    .from(listingPriceRequests)
    .where(and(eq(listingPriceRequests.shopProductId, shopProductId), eq(listingPriceRequests.customerId, customerId), eq(listingPriceRequests.status, "OPEN")));
  if (existing) return { request: existing, alreadyAsked: true };
  const [request] = await db
    .insert(listingPriceRequests)
    .values({ shopProductId, shopId: row.shop.id, customerId, quantity: input.quantity ?? null, note: input.note?.trim().slice(0, 300) || null })
    .returning();
  await recordAudit({
    actorId: customerId,
    actorRole: "CUSTOMER",
    action: AUDIT_ACTIONS.LISTING_PRICE_REQUESTED,
    entityType: "shop_product",
    entityId: shopProductId,
    newValue: { requestId: request.id, quantity: input.quantity ?? null },
  });
  await notify({
    userId: row.shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_PRICE_REQUESTED,
    title: "A customer asks a price",
    body: `Price needed for ${row.product.name}${input.quantity ? ` (${input.quantity} ${row.product.unit})` : ""}. Set the price so they can order.`,
    actionUrl: "/shop/puja?tab=prices",
    channels: ["PUSH"],
    metadata: { requestId: request.id, shopProductId },
  });
  return { request, alreadyAsked: false };
}

export async function listShopPriceRequests(shopId: string, status: "OPEN" | "ALL" = "OPEN") {
  return db
    .select({
      id: listingPriceRequests.id,
      shopProductId: listingPriceRequests.shopProductId,
      productName: products.name,
      unit: products.unit,
      kind: products.kind,
      customerName: users.name,
      quantity: listingPriceRequests.quantity,
      note: listingPriceRequests.note,
      status: listingPriceRequests.status,
      pricePaise: listingPriceRequests.pricePaise,
      createdAt: listingPriceRequests.createdAt,
      answeredAt: listingPriceRequests.answeredAt,
    })
    .from(listingPriceRequests)
    .innerJoin(shopProducts, eq(shopProducts.id, listingPriceRequests.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(users, eq(users.id, listingPriceRequests.customerId))
    .where(and(eq(listingPriceRequests.shopId, shopId), status === "OPEN" ? eq(listingPriceRequests.status, "OPEN") : undefined))
    .orderBy(desc(listingPriceRequests.createdAt))
    .limit(200);
}

export async function listMyPriceRequests(customerId: string) {
  return db
    .select({
      id: listingPriceRequests.id,
      shopProductId: listingPriceRequests.shopProductId,
      productId: products.id,
      productName: products.name,
      shopName: shops.name,
      status: listingPriceRequests.status,
      pricePaise: listingPriceRequests.pricePaise,
      createdAt: listingPriceRequests.createdAt,
    })
    .from(listingPriceRequests)
    .innerJoin(shopProducts, eq(shopProducts.id, listingPriceRequests.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, listingPriceRequests.shopId))
    .where(eq(listingPriceRequests.customerId, customerId))
    .orderBy(desc(listingPriceRequests.createdAt))
    .limit(50);
}

/**
 * The shop answers: the listing gets this price (online and in the shop) and goes on sale;
 * every customer waiting on it is told at once. Declining closes the requests with a note.
 */
export async function answerPriceRequest(
  shopId: string,
  requestId: string,
  input: { pricePaise?: number | null; decline?: boolean },
  actor: Actor,
) {
  const [req] = await db
    .select()
    .from(listingPriceRequests)
    .where(and(eq(listingPriceRequests.id, requestId), eq(listingPriceRequests.shopId, shopId)));
  if (!req) throw notFound("Price request");
  if (req.status !== "OPEN") throw conflict("This request has already been answered.");
  const [listing] = await db
    .select({ sp: shopProducts, product: products, shopMrp: shopListingDetails.mrpPaise })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(eq(shopProducts.id, req.shopProductId));
  if (!listing) throw notFound("Product");

  const open = await db
    .select({ id: listingPriceRequests.id, customerId: listingPriceRequests.customerId })
    .from(listingPriceRequests)
    .where(and(eq(listingPriceRequests.shopProductId, req.shopProductId), eq(listingPriceRequests.status, "OPEN")));

  if (input.decline) {
    await db
      .update(listingPriceRequests)
      .set({ status: "DECLINED", answeredBy: actor.id, answeredAt: new Date() })
      .where(inArray(listingPriceRequests.id, open.map((o) => o.id)));
    for (const o of open) {
      await notify({
        userId: o.customerId,
        type: NOTIFICATION_TYPES.CUSTOMER_PRICE_CONFIRMED,
        title: "Item not available",
        body: `The shop cannot supply ${listing.product.name} right now.`,
        actionUrl: "/puja",
        channels: ["PUSH"],
      });
    }
    return { status: "DECLINED", customers: open.length };
  }

  const price = input.pricePaise;
  if (price == null || !(price > 0) || price > 100_000_000) throw validationFailed("Enter the price in rupees.");
  const mrp = listing.shopMrp ?? listing.product.mrpPaise;
  if (mrp != null && price > mrp) throw validationFailed(`The price is above the MRP (₹${(mrp / 100).toFixed(2)}).`);

  await db.transaction(async (tx) => {
    await tx
      .update(shopProducts)
      .set({ onlinePricePaise: price, offlinePricePaise: price, onlineSaleEnabled: true, offlineSaleEnabled: true, updatedAt: new Date() })
      .where(eq(shopProducts.id, req.shopProductId));
    await tx.insert(productPriceHistory).values([
      { shopProductId: req.shopProductId, priceType: "ONLINE", previousPricePaise: listing.sp.onlinePricePaise, newPricePaise: price, changedBy: actor.id, reason: "Price on confirmation" },
      { shopProductId: req.shopProductId, priceType: "OFFLINE", previousPricePaise: listing.sp.offlinePricePaise, newPricePaise: price, changedBy: actor.id, reason: "Price on confirmation" },
    ]);
    await tx
      .update(listingPriceRequests)
      .set({ status: "ANSWERED", pricePaise: price, answeredBy: actor.id, answeredAt: new Date() })
      .where(inArray(listingPriceRequests.id, open.map((o) => o.id)));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.LISTING_PRICE_ANSWERED,
        entityType: "shop_product",
        entityId: req.shopProductId,
        previousValue: { onlinePricePaise: listing.sp.onlinePricePaise },
        newValue: { onlinePricePaise: price, requests: open.length },
      },
      tx,
    );
  });
  for (const o of open) {
    await notify({
      userId: o.customerId,
      type: NOTIFICATION_TYPES.CUSTOMER_PRICE_CONFIRMED,
      title: "Price confirmed",
      body: `${listing.product.name}: ₹${(price / 100).toFixed(2)} per ${listing.product.unit}. You can add it to your cart now.`,
      actionUrl: `/products/${listing.product.id}`,
      channels: ["PUSH"],
      metadata: { shopProductId: req.shopProductId, pricePaise: price },
    });
  }
  return { status: "ANSWERED", customers: open.length, pricePaise: price };
}

/** Puja shops by name for the storefront's shop filter (primary or added type). */
export async function listPujaShopIds(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT s.id FROM shops s
     WHERE s.status = 'APPROVED' AND s.deleted_at IS NULL
       AND (s.shop_type = ${PUJA_SHOP_TYPE_KEY}
            OR EXISTS (SELECT 1 FROM shop_added_types a WHERE a.shop_id = s.id AND a.shop_type_key = ${PUJA_SHOP_TYPE_KEY}))`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
