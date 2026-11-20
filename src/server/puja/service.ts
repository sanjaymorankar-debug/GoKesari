/**
 * Puja Samagri & Temple Supplies — shop owner side (docs/puja-samagri-2026-11).
 *
 *   - browse the master catalogue (category, product type, festival, loose / packed, search in
 *     English, Hindi, Marathi and synonyms) and see what the shop already lists;
 *   - take the catalogue: every product of the chosen categories goes into the shop at the
 *     seed stock (100), priced at its MRP; loose goods and items without an MRP go in with an
 *     empty price for the owner to set (rule 3 of the brief). Categories or products the owner
 *     unticks are left out. A shop of another type gets the type as an added type;
 *   - restore listings it removed earlier;
 *   - create its own product types and products (duplicate check first, close matches first);
 *     both are usable in the shop at once and wait in the review queue for the master.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { roundStock } from "@/lib/stock-quantity";
import { checkCommissionMilestonesSafely } from "@/server/dealers/commission";
import { db, type DbClient } from "@/server/db";
import {
  inventoryMovements,
  productCatalogueAttrs,
  productCategories,
  productLocalNames,
  products,
  productSubcategories,
  shopAddedTypes,
  shopProducts,
  shops,
  shopTypes,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { levenshtein, normaliseProductName, uniqueSlug } from "@/server/services/catalogue";
import { addCategoryToShop } from "@/server/services/product-categories";
import { getRule } from "@/server/services/settings";
import type { UserRole } from "@/server/db/schema";

import { PUJA_CATEGORIES, PUJA_SHOP_TYPE_KEY, slugify } from "./catalogue";

export type Actor = { id: string; role: UserRole };
type ListingActor = { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" };

/* ---------------------------------------------------------------- reads */

export interface PujaCategoryRow {
  id: string;
  slug: string;
  name: string;
  nameHi: string;
  nameMr: string;
  emoji: string;
  productCount: number;
}

/** The live puja categories with their product counts (Hindi / Marathi names from the catalogue file). */
export async function listPujaCategories(client: DbClient = db): Promise<PujaCategoryRow[]> {
  const rows = await client
    .select({
      id: productCategories.id,
      slug: productCategories.slug,
      name: productCategories.name,
      // Written fully qualified: drizzle renders a single-table query's columns bare, and a bare
      // "id" inside the subquery would bind to products.id.
      count: sql<number>`(SELECT count(*)::int FROM products p WHERE p.category_id = "product_categories"."id"
        AND p.is_active AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED')`.mapWith(Number),
    })
    .from(productCategories)
    .where(and(eq(productCategories.department, PUJA_SHOP_TYPE_KEY), eq(productCategories.isActive, true), isNull(productCategories.deletedAt)))
    .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));
  return rows.map((r) => {
    const def = PUJA_CATEGORIES.find((c) => c.slug === r.slug);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      nameHi: def?.hi ?? r.name,
      nameMr: def?.mr ?? r.name,
      emoji: def?.emoji ?? "🪔",
      productCount: r.count,
    };
  });
}

export interface PujaTypeRow {
  id: string;
  categoryId: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  approvalStatus: string;
  ownedByShop: boolean;
  defaultUnit: string | null;
  isLoose: boolean;
  isPerishable: boolean;
  isEdible: boolean;
}

/** Product types of the puja categories: approved ones, plus the shop's own (any status but merged). */
export async function listPujaTypes(shopId?: string | null, client: DbClient = db): Promise<PujaTypeRow[]> {
  const rows = await client
    .select({
      id: productSubcategories.id,
      categoryId: productSubcategories.categoryId,
      name: productSubcategories.name,
      nameHi: productSubcategories.nameHi,
      nameMr: productSubcategories.nameMr,
      approvalStatus: productSubcategories.approvalStatus,
      ownerShopId: productSubcategories.ownerShopId,
      defaultUnit: productSubcategories.defaultUnit,
      isLoose: productSubcategories.isLoose,
      isPerishable: productSubcategories.isPerishable,
      isEdible: productSubcategories.isEdible,
    })
    .from(productSubcategories)
    .innerJoin(productCategories, eq(productCategories.id, productSubcategories.categoryId))
    .where(
      and(
        eq(productCategories.department, PUJA_SHOP_TYPE_KEY),
        isNull(productSubcategories.deletedAt),
        eq(productSubcategories.isActive, true),
        shopId
          ? sql`(${productSubcategories.approvalStatus} = 'APPROVED' OR (${productSubcategories.ownerShopId} = ${shopId}::uuid AND ${productSubcategories.approvalStatus} <> 'MERGED'))`
          : eq(productSubcategories.approvalStatus, "APPROVED"),
      ),
    )
    .orderBy(asc(productSubcategories.sortOrder), asc(productSubcategories.name));
  return rows.map(({ ownerShopId, ...r }) => ({ ...r, ownedByShop: Boolean(shopId && ownerShopId === shopId) }));
}

export interface CatalogueFilters {
  shopId?: string | null;
  categoryId?: string | null;
  typeId?: string | null;
  festival?: string | null;
  /** "loose" or "packed". */
  kind?: "loose" | "packed" | null;
  q?: string | null;
  /** Only products the shop does not list yet. */
  notListed?: boolean;
  /** Staff view: retired and merged products too. */
  includeRetired?: boolean;
  /** Staff view: only products whose HSN/GST still needs the CA's check. */
  taxToVerify?: boolean;
  limit?: number;
  offset?: number;
}

export interface CatalogueItem {
  productId: string;
  code: string;
  slug: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  synonyms: string[];
  categoryId: string;
  categoryName: string;
  typeId: string | null;
  typeName: string | null;
  variant: string | null;
  unit: string;
  sellUnit: string | null;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  taxToVerify: boolean;
  perishable: boolean;
  edible: boolean;
  festivals: string[];
  imageUrl: string | null;
  approvalStatus: string;
  isActive: boolean;
  mergedIntoProductId: string | null;
  /** The shop's listing, when a shop was given: LIVE (listed) or REMOVED (soft-deleted). */
  listing: { id: string; state: "LISTED" | "REMOVED"; pricePaise: number | null; stock: number } | null;
}

/** Each word must match the English name, the Hindi / Marathi names, a synonym or the category. */
export function catalogueSearchCondition(q: string | null | undefined) {
  const words = (q ?? "").split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 6);
  if (!words.length) return undefined;
  return and(
    ...words.map((w) => {
      const term = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase()}%`;
      return sql`(lower(${products.name}) LIKE ${term} OR lower(${productCategories.name}) LIKE ${term}
        OR EXISTS (SELECT 1 FROM product_local_names pln WHERE pln.product_id = "products"."id" AND pln.search_text LIKE ${term}))`;
    }),
  );
}

export async function browsePujaCatalogue(filters: CatalogueFilters, client: DbClient = db): Promise<{ items: CatalogueItem[]; total: number }> {
  const shopId = filters.shopId ?? null;
  const conditions = [
    eq(productCategories.department, PUJA_SHOP_TYPE_KEY),
    isNull(productCategories.deletedAt),
    isNull(products.deletedAt),
  ];
  if (!filters.includeRetired) {
    conditions.push(eq(products.isActive, true), eq(productCategories.isActive, true));
    conditions.push(sql`${productCatalogueAttrs.mergedIntoProductId} IS NULL`);
    // Approved products, plus the shop's own products waiting for review.
    conditions.push(
      shopId
        ? sql`(${products.approvalStatus} = 'APPROVED' OR (${products.approvalStatus} = 'PENDING_APPROVAL' AND ${shopProducts.id} IS NOT NULL))`
        : eq(products.approvalStatus, "APPROVED"),
    );
  }
  if (filters.categoryId) conditions.push(eq(products.categoryId, filters.categoryId));
  if (filters.typeId) conditions.push(eq(products.subcategoryId, filters.typeId));
  if (filters.festival) conditions.push(sql`${filters.festival} = ANY(${productCatalogueAttrs.festivals})`);
  if (filters.kind === "loose") conditions.push(eq(products.kind, "LOOSE"));
  if (filters.kind === "packed") conditions.push(eq(products.kind, "PACKAGED"));
  if (filters.notListed && shopId) conditions.push(sql`(${shopProducts.id} IS NULL)`);
  if (filters.taxToVerify) conditions.push(sql`${productCatalogueAttrs.taxToVerify}`);
  const search = catalogueSearchCondition(filters.q);
  if (search) conditions.push(search);

  const base = client
    .select({
      product: products,
      categoryName: productCategories.name,
      typeName: productSubcategories.name,
      nameHi: productLocalNames.nameHi,
      nameMr: productLocalNames.nameMr,
      synonyms: productLocalNames.synonyms,
      sellUnit: productCatalogueAttrs.sellUnit,
      perishable: productCatalogueAttrs.isPerishable,
      edible: productCatalogueAttrs.isEdible,
      festivals: productCatalogueAttrs.festivals,
      taxToVerify: productCatalogueAttrs.taxToVerify,
      mergedInto: productCatalogueAttrs.mergedIntoProductId,
      listingId: shopProducts.id,
      listingDeletedAt: shopProducts.deletedAt,
      listingPrice: shopProducts.onlinePricePaise,
      listingOfflinePrice: shopProducts.offlinePricePaise,
      listingStock: shopProducts.onlineStock,
      total: sql<number>`count(*) OVER ()`.mapWith(Number),
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(productSubcategories, eq(productSubcategories.id, products.subcategoryId))
    .leftJoin(productLocalNames, eq(productLocalNames.productId, products.id))
    .leftJoin(productCatalogueAttrs, eq(productCatalogueAttrs.productId, products.id))
    .leftJoin(shopProducts, shopId ? and(eq(shopProducts.productId, products.id), eq(shopProducts.shopId, shopId)) : sql`false`)
    .where(and(...conditions))
    .orderBy(asc(productCategories.sortOrder), asc(productSubcategories.sortOrder), asc(products.name))
    .limit(Math.min(filters.limit ?? 100, 600))
    .offset(filters.offset ?? 0);
  const rows = await base;
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      productId: r.product.id,
      code: r.product.code,
      slug: r.product.slug,
      name: r.product.name,
      nameHi: r.nameHi,
      nameMr: r.nameMr,
      synonyms: r.synonyms ?? [],
      categoryId: r.product.categoryId,
      categoryName: r.categoryName,
      typeId: r.product.subcategoryId,
      typeName: r.typeName,
      variant: r.product.variant,
      unit: r.product.unit,
      sellUnit: r.sellUnit,
      kind: r.product.kind,
      mrpPaise: r.product.mrpPaise,
      hsnCode: r.product.hsnCode,
      gstRateBp: r.product.gstRateBp,
      taxToVerify: r.taxToVerify ?? false,
      perishable: r.perishable ?? false,
      edible: r.edible ?? false,
      festivals: r.festivals ?? [],
      imageUrl: r.product.imageUrl,
      approvalStatus: r.product.approvalStatus,
      isActive: r.product.isActive,
      mergedIntoProductId: r.mergedInto ?? null,
      listing: r.listingId
        ? {
            id: r.listingId,
            state: r.listingDeletedAt ? "REMOVED" : "LISTED",
            pricePaise: r.listingPrice ?? r.listingOfflinePrice ?? null,
            stock: Number(r.listingStock ?? 0),
          }
        : null,
    })),
  };
}

/** What the "take the puja catalogue" screen needs: categories, how much the shop already lists. */
export async function getPujaSetup(shopId: string) {
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, shopType: shops.shopType })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const [categories, rule, typeRow, added, listed] = await Promise.all([
    listPujaCategories(),
    getRule("pujaSamagri"),
    db.select({ status: shopTypes.status, label: shopTypes.label }).from(shopTypes).where(eq(shopTypes.key, PUJA_SHOP_TYPE_KEY)),
    db.select({ key: shopAddedTypes.shopTypeKey }).from(shopAddedTypes).where(and(eq(shopAddedTypes.shopId, shopId), eq(shopAddedTypes.shopTypeKey, PUJA_SHOP_TYPE_KEY))),
    db
      .select({ categoryId: products.categoryId, n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt), eq(productCategories.department, PUJA_SHOP_TYPE_KEY)))
      .groupBy(products.categoryId),
  ]);
  const listedBy = new Map(listed.map((l) => [l.categoryId, l.n]));
  return {
    shop,
    typeEnabled: (typeRow[0]?.status ?? "INACTIVE") === "ACTIVE",
    isPujaShop: shop.shopType === PUJA_SHOP_TYPE_KEY || added.length > 0,
    primaryIsPuja: shop.shopType === PUJA_SHOP_TYPE_KEY,
    defaultStock: rule.seedDefaultStock,
    categories: categories.map((c) => ({ ...c, listed: listedBy.get(c.id) ?? 0 })),
  };
}

/* ------------------------------------------------------- take the catalogue */

export interface SeedOptions {
  /** Categories the owner unticked. */
  excludeCategoryIds?: readonly string[];
  /** Products the owner unticked. */
  excludeProductIds?: readonly string[];
  /** Browse mode: list only these products (multi-select "add to my shop"). */
  onlyProductIds?: readonly string[];
}

export interface SeedResult {
  added: number;
  /** Added with an empty price (loose goods, or no MRP): the owner sets it. */
  needsPrice: number;
  alreadyListed: number;
  /** Listings the shop removed earlier: left removed (Restore brings them back). */
  previouslyRemoved: number;
  categoriesLinked: number;
  stock: number;
  addedType: boolean;
  /** The shop had no live listings before: its first products (onboarding notice). */
  firstProducts: boolean;
}

/**
 * Lists the puja catalogue in a shop (brief rule 3). One transaction: the categories are
 * linked, every listing is written, the opening stock goes to the stock ledger, and a shop of
 * another type is recorded as carrying the puja range. Safe to repeat: listed products are
 * skipped, so a second run adds only what is new in the catalogue.
 */
export async function seedPujaCatalogue(shopId: string, options: SeedOptions, actor: ListingActor): Promise<SeedResult> {
  const [shop] = await db
    .select({ id: shops.id, shopType: shops.shopType })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const [type] = await db.select({ status: shopTypes.status }).from(shopTypes).where(eq(shopTypes.key, PUJA_SHOP_TYPE_KEY));
  if (type?.status !== "ACTIVE") throw conflict("The Puja Samagri shop type is switched off.");
  const rule = await getRule("pujaSamagri");
  const stock = rule.seedDefaultStock;

  const excludedCats = new Set(options.excludeCategoryIds ?? []);
  const excludedProducts = new Set(options.excludeProductIds ?? []);
  const only = options.onlyProductIds ? new Set(options.onlyProductIds) : null;
  if (only && only.size === 0) throw validationFailed("Tick at least one product.");

  const candidates = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      mrpPaise: products.mrpPaise,
      kind: products.kind,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(productCatalogueAttrs, eq(productCatalogueAttrs.productId, products.id))
    .where(
      and(
        eq(productCategories.department, PUJA_SHOP_TYPE_KEY),
        eq(productCategories.isActive, true),
        isNull(productCategories.deletedAt),
        eq(products.isActive, true),
        isNull(products.deletedAt),
        eq(products.approvalStatus, "APPROVED"),
        sql`${productCatalogueAttrs.mergedIntoProductId} IS NULL`,
        only ? inArray(products.id, [...only]) : undefined,
      ),
    );
  const wanted = candidates.filter((c) => !excludedCats.has(c.categoryId) && !excludedProducts.has(c.id));
  if (wanted.length === 0) throw validationFailed("Nothing to add: every category or product is unticked.");

  const existing = await db
    .select({ productId: shopProducts.productId, deletedAt: shopProducts.deletedAt })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.productId, wanted.map((w) => w.id))));
  const existingBy = new Map(existing.map((e) => [e.productId, e]));
  const fresh = wanted.filter((w) => !existingBy.has(w.id));
  const alreadyListed = existing.filter((e) => !e.deletedAt).length;
  const [before] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  const previouslyRemoved = existing.filter((e) => e.deletedAt).length;

  const result = await db.transaction(async (tx) => {
    const categories = [...new Set(wanted.map((w) => w.categoryId))];
    for (const categoryId of categories) {
      await addCategoryToShop(shopId, categoryId, actor, { reason: "puja catalogue" }, tx);
    }
    let addedType = false;
    if (shop.shopType !== PUJA_SHOP_TYPE_KEY) {
      const inserted = await tx
        .insert(shopAddedTypes)
        .values({ shopId, shopTypeKey: PUJA_SHOP_TYPE_KEY, addedBy: actor.id })
        .onConflictDoNothing()
        .returning({ shopId: shopAddedTypes.shopId });
      addedType = inserted.length > 0;
    }
    let added = 0;
    let needsPrice = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const rows = await tx
        .insert(shopProducts)
        .values(
          chunk.map((p) => {
            // Rule 3: priced at the MRP where the master has one; loose goods and items without
            // an MRP go in with an empty price, not on sale, until the owner sets one.
            const price = p.kind === "LOOSE" ? null : p.mrpPaise;
            return {
              shopId,
              productId: p.id,
              onlinePricePaise: price,
              offlinePricePaise: price,
              onlineSaleEnabled: price != null,
              offlineSaleEnabled: price != null,
              trackInventory: true,
              onlineStock: roundStock(stock),
              offlineStock: 0,
              isActive: true,
              isAvailable: true,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: shopProducts.id, price: shopProducts.onlinePricePaise });
      added += rows.length;
      needsPrice += rows.filter((r) => r.price == null).length;
      if (stock > 0 && rows.length) {
        await tx.insert(inventoryMovements).values(
          rows.map((r) => ({
            shopProductId: r.id,
            channel: "ONLINE" as const,
            deltaUnits: stock,
            previousUnits: 0,
            newUnits: stock,
            reason: "Puja catalogue (opening stock)",
            source: "puja_catalogue",
            createdBy: actor.id,
          })),
        );
      }
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PUJA_CATALOGUE_SEEDED,
        entityType: "shop",
        entityId: shopId,
        newValue: {
          added,
          needsPrice,
          alreadyListed,
          previouslyRemoved,
          stock,
          excludedCategories: [...excludedCats],
          excludedProducts: excludedProducts.size,
          browse: Boolean(only),
        },
      },
      tx,
    );
    if (addedType) {
      await recordAudit(
        { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SHOP_TYPE_ADDED, entityType: "shop", entityId: shopId, newValue: { shopTypeKey: PUJA_SHOP_TYPE_KEY } },
        tx,
      );
    }
    return { added, needsPrice, categoriesLinked: categories.length, addedType };
  });
  if (result.added > 0) await checkCommissionMilestonesSafely(shopId);
  return { ...result, alreadyListed, previouslyRemoved, stock, firstProducts: (before?.n ?? 0) === 0 && result.added > 0 };
}

/* --------------------------------------------------------- remove / restore */

export async function listRemovedListings(shopId: string) {
  return db
    .select({
      id: shopProducts.id,
      productId: products.id,
      name: products.name,
      categoryName: productCategories.name,
      removedAt: shopProducts.deletedAt,
      pricePaise: shopProducts.onlinePricePaise,
      stock: shopProducts.onlineStock,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(and(eq(shopProducts.shopId, shopId), isNotNull(shopProducts.deletedAt)))
    .orderBy(sql`${shopProducts.deletedAt} DESC`)
    .limit(500);
}

/**
 * Brings removed listings back as they were (price, stock and order history were never
 * deleted). A listing with a price goes back on sale; one without waits for its price.
 */
export async function restoreListings(shopId: string, listingIds: readonly string[], actor: ListingActor): Promise<{ restored: number }> {
  if (!listingIds.length) throw validationFailed("Choose at least one product to restore.");
  const rows = await db
    .select({ id: shopProducts.id, categoryId: products.categoryId })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.id, [...listingIds]), isNotNull(shopProducts.deletedAt)));
  if (!rows.length) throw notFound("Removed product");
  await db.transaction(async (tx) => {
    for (const categoryId of new Set(rows.map((r) => r.categoryId))) {
      await addCategoryToShop(shopId, categoryId, actor, { reason: "listing restored" }, tx);
    }
    await tx
      .update(shopProducts)
      .set({
        deletedAt: null,
        isActive: true,
        isAvailable: true,
        onlineSaleEnabled: sql`${shopProducts.onlinePricePaise} IS NOT NULL`,
        offlineSaleEnabled: sql`${shopProducts.offlinePricePaise} IS NOT NULL`,
        updatedAt: new Date(),
      })
      .where(inArray(shopProducts.id, rows.map((r) => r.id)));
    for (const r of rows) {
      await recordAudit(
        { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.LISTING_RESTORED, entityType: "shop_product", entityId: r.id, newValue: { restored: true } },
        tx,
      );
    }
  });
  return { restored: rows.length };
}

/* -------------------------------------------------- owner-created product types */

export interface SimilarMatch {
  id: string;
  name: string;
  /** 0 = same name; higher = further away. Close matches first. */
  distance: number;
  status: string;
}

function closeness(a: string, b: string): number | null {
  const x = normaliseProductName(a);
  const y = normaliseProductName(b);
  if (!x || !y) return null;
  if (x === y) return 0;
  const threshold = Math.max(1, Math.floor(Math.min(x.length, y.length) * 0.25));
  const d = levenshtein(x, y);
  if (d <= threshold) return d;
  if (x.includes(y) || y.includes(x)) return threshold + 1;
  return null;
}

function localCloseness(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  return a.trim().toLowerCase() === b.trim().toLowerCase() ? 0 : null;
}

/** Product types in a category whose name is the same or close (English, or the same Hindi / Marathi name). */
export async function findSimilarTypes(
  input: { categoryId: string; name: string; nameHi?: string | null; nameMr?: string | null; shopId?: string | null },
  client: DbClient = db,
): Promise<SimilarMatch[]> {
  const rows = await client
    .select({
      id: productSubcategories.id,
      name: productSubcategories.name,
      nameHi: productSubcategories.nameHi,
      nameMr: productSubcategories.nameMr,
      status: productSubcategories.approvalStatus,
      ownerShopId: productSubcategories.ownerShopId,
    })
    .from(productSubcategories)
    .where(and(eq(productSubcategories.categoryId, input.categoryId), isNull(productSubcategories.deletedAt)));
  const matches: SimilarMatch[] = [];
  for (const r of rows) {
    if (r.status === "REJECTED" || r.status === "MERGED") continue;
    // Another shop's type still waiting for review is private to that shop.
    if (r.status === "PENDING_APPROVAL" && r.ownerShopId !== input.shopId) continue;
    const ds = [closeness(input.name, r.name), localCloseness(input.nameHi, r.nameHi), localCloseness(input.nameMr, r.nameMr)].filter(
      (d): d is number => d != null,
    );
    if (ds.length) matches.push({ id: r.id, name: r.name, distance: Math.min(...ds), status: r.status });
  }
  return matches.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
}

export interface NewTypeInput {
  categoryId: string;
  name: string;
  nameHi?: string | null;
  nameMr?: string | null;
  unit: string;
  variantAttributes?: readonly string[];
  loose?: boolean;
  perishable?: boolean;
  edible?: boolean;
  confirmDuplicate?: boolean;
}

/**
 * An owner's own product type: usable in the shop at once, PENDING_APPROVAL for the master
 * (staff-created types are approved at once). The duplicate check runs first: an exact or
 * close match stops it (409, matches closest first) until the owner confirms.
 */
export async function createProductType(shopId: string, input: NewTypeInput, actor: ListingActor) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) throw validationFailed("The product type needs a name of at least 2 letters.");
  const [category] = await db
    .select({ id: productCategories.id, name: productCategories.name, isActive: productCategories.isActive })
    .from(productCategories)
    .where(and(eq(productCategories.id, input.categoryId), isNull(productCategories.deletedAt)));
  if (!category) throw notFound("Category");
  if (!category.isActive) throw validationFailed(`"${category.name}" is switched off — choose another category.`);

  const matches = await findSimilarTypes({ ...input, name, shopId });
  const exact = matches.find((m) => m.distance === 0);
  if (exact) {
    throw conflict(`"${exact.name}" already exists in ${category.name}. Use it instead of creating a new type.`, { matches, exact: true });
  }
  if (matches.length && !input.confirmDuplicate) {
    throw conflict(`Similar product types already exist: ${matches.map((m) => m.name).join(", ")}. Use one of them, or confirm to create "${name}" anyway.`, {
      matches,
    });
  }
  const owner = actor.role === "SHOP_OWNER";
  const row = await db.transaction(async (tx) => {
    await addCategoryToShop(shopId, category.id, actor, { reason: "product type created" }, tx);
    const [created] = await tx
      .insert(productSubcategories)
      .values({
        categoryId: category.id,
        name,
        slug: `own-${slugify(name) || "type"}-${crypto.randomUUID().slice(0, 8)}`,
        sortOrder: 1000,
        nameHi: input.nameHi?.trim() || null,
        nameMr: input.nameMr?.trim() || null,
        ownerShopId: shopId,
        createdBy: actor.id,
        approvalStatus: owner ? "PENDING_APPROVAL" : "APPROVED",
        defaultUnit: input.unit.trim(),
        variantAttributes: [...(input.variantAttributes ?? [])].map((v) => v.trim()).filter(Boolean).slice(0, 8),
        isLoose: Boolean(input.loose),
        isPerishable: Boolean(input.perishable),
        isEdible: Boolean(input.edible),
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_TYPE_CREATED,
        entityType: "product_subcategory",
        entityId: created.id,
        newValue: { name, categoryId: category.id, shopId, approvalStatus: created.approvalStatus, similarConfirmed: matches.map((m) => m.name) },
      },
      tx,
    );
    return created;
  });
  return { type: row, similar: matches };
}

/* ------------------------------------------------------ owner-created products */

export interface NewProductInput {
  categoryId: string;
  typeId?: string | null;
  name: string;
  nameHi?: string | null;
  nameMr?: string | null;
  synonyms?: readonly string[];
  unit: string;
  loose?: boolean;
  perishable?: boolean;
  edible?: boolean;
  description?: string | null;
  hsnCode?: string | null;
  gstRateBp?: number | null;
  festivals?: readonly string[];
  variants: readonly { label?: string | null; mrpPaise?: number | null; pricePaise?: number | null; stock: number }[];
  confirmDuplicate?: boolean;
}

const UNIT_TO_PRODUCT_UNIT: Record<string, string> = { pcs: "piece", piece: "piece", pack: "pack", box: "box", dozen: "dozen", g: "g", kg: "kg", ml: "ml", L: "L", l: "L" };

/** Lower-cased search text from the names and synonyms (same expression as the seed, 0154). */
export function buildSearchText(parts: readonly (string | null | undefined)[], synonyms: readonly string[]): string {
  return [...parts, ...synonyms]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
}

/**
 * An owner's own product, one master product per variant, listed in the shop at once with the
 * owner's price and stock. Owner-created products wait in the review queue (PENDING_APPROVAL);
 * only approval lets other shops find them. An exact name match in the category lists the
 * existing product instead; a close one stops it (409) until the owner confirms.
 */
export async function createOwnProducts(shopId: string, input: NewProductInput, actor: ListingActor) {
  const baseName = input.name.trim().replace(/\s+/g, " ");
  if (baseName.length < 2) throw validationFailed("The product needs a name of at least 2 letters.");
  if (!input.variants.length) throw validationFailed("Add at least one variant (size, weight or pack).");
  if (input.variants.length > 12) throw validationFailed("At most 12 variants at a time.");
  const unit = UNIT_TO_PRODUCT_UNIT[input.unit.trim()] ?? input.unit.trim();
  if (!unit) throw validationFailed("Choose a unit.");

  const [category] = await db
    .select({ id: productCategories.id, name: productCategories.name, isActive: productCategories.isActive, department: productCategories.department })
    .from(productCategories)
    .where(and(eq(productCategories.id, input.categoryId), isNull(productCategories.deletedAt)));
  if (!category) throw notFound("Category");
  if (!category.isActive) throw validationFailed(`"${category.name}" is switched off — choose another category.`);
  let typeName: string | null = null;
  let typeHi: string | null = null;
  let typeMr: string | null = null;
  if (input.typeId) {
    const [type] = await db
      .select()
      .from(productSubcategories)
      .where(and(eq(productSubcategories.id, input.typeId), isNull(productSubcategories.deletedAt)));
    if (!type || type.categoryId !== category.id) throw validationFailed("That product type is not in this category.");
    const usable = type.approvalStatus === "APPROVED" || (type.ownerShopId === shopId && type.approvalStatus !== "MERGED");
    if (!usable) throw validationFailed("That product type is not available to your shop.");
    typeName = type.name;
    typeHi = type.nameHi;
    typeMr = type.nameMr;
  }

  const variants = input.variants.map((v) => {
    const label = v.label?.trim() || null;
    const name = label ? `${baseName} – ${label}` : baseName;
    if (v.mrpPaise != null && v.pricePaise != null && v.pricePaise > v.mrpPaise) {
      throw validationFailed(`${name}: the price is above the MRP.`);
    }
    if (!(v.stock >= 0)) throw validationFailed(`${name}: stock must be 0 or more.`);
    return { ...v, label, name };
  });

  // Duplicate check, closest first, across every variant.
  const similar: SimilarMatch[] = [];
  const exactBy = new Map<string, { id: string; name: string }>();
  const candidates = await db
    .select({ id: products.id, name: products.name, status: products.approvalStatus })
    .from(products)
    .where(and(eq(products.categoryId, category.id), isNull(products.deletedAt), sql`${products.approvalStatus} <> 'REJECTED'`));
  for (const v of variants) {
    for (const c of candidates) {
      const d = closeness(v.name, c.name);
      if (d === 0) exactBy.set(v.name, { id: c.id, name: c.name });
      else if (d != null && !similar.some((s) => s.id === c.id)) similar.push({ id: c.id, name: c.name, distance: d, status: c.status });
    }
  }
  similar.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  if (similar.length && !input.confirmDuplicate) {
    throw conflict(
      `This looks like products already in the catalogue: ${similar.slice(0, 5).map((s) => s.name).join(", ")}. Add one of them from the catalogue, or confirm to create yours anyway.`,
      { matches: similar.slice(0, 10) },
    );
  }

  const owner = actor.role === "SHOP_OWNER";
  const kind = input.loose ? ("LOOSE" as const) : ("PACKAGED" as const);
  const catalogue = category.department === PUJA_SHOP_TYPE_KEY ? PUJA_SHOP_TYPE_KEY : "GENERAL";
  const synonyms = [...new Set((input.synonyms ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 30);

  const created = await db.transaction(async (tx) => {
    await addCategoryToShop(shopId, category.id, actor, { reason: "product created" }, tx);
    const out: { productId: string; listingId: string; name: string; reused: boolean }[] = [];
    for (const v of variants) {
      const price = v.pricePaise ?? null;
      const stock = roundStock(v.stock);
      const existing = exactBy.get(v.name);
      let productId: string;
      if (existing) {
        productId = existing.id;
      } else {
        const [product] = await tx
          .insert(products)
          .values({
            categoryId: category.id,
            subcategoryId: input.typeId ?? null,
            name: v.name,
            slug: uniqueSlug(v.name),
            description: input.description?.trim() || null,
            kind,
            variant: v.label,
            mrpPaise: kind === "LOOSE" ? null : (v.mrpPaise ?? null),
            mrpSource: kind === "LOOSE" || v.mrpPaise == null ? null : "SELLER_SUBMITTED",
            hsnCode: input.hsnCode?.trim() || null,
            gstRateBp: input.gstRateBp ?? null,
            unit,
            unitSizeMilli: 1000,
            subscribable: false,
            approvalStatus: owner ? "PENDING_APPROVAL" : "APPROVED",
            createdBy: actor.id,
          })
          .returning({ id: products.id });
        productId = product.id;
        await tx.insert(productLocalNames).values({
          productId,
          nameHi: input.nameHi?.trim() ? `${input.nameHi.trim()}${v.label ? ` – ${v.label}` : ""}` : null,
          nameMr: input.nameMr?.trim() ? `${input.nameMr.trim()}${v.label ? ` – ${v.label}` : ""}` : null,
          synonyms,
          searchText: buildSearchText([v.name, input.nameHi, input.nameMr, typeName, typeHi, typeMr], synonyms),
          updatedBy: actor.id,
        });
        await tx.insert(productCatalogueAttrs).values({
          productId,
          catalogue,
          sellUnit: input.unit.trim(),
          isPerishable: Boolean(input.perishable),
          isEdible: Boolean(input.edible),
          festivals: [...(input.festivals ?? [])],
          variantAttrs: v.label ? { variant: v.label } : {},
          taxToVerify: true,
          updatedBy: actor.id,
        });
        await recordAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: AUDIT_ACTIONS.GLOBAL_PRODUCT_CREATED,
            entityType: "product",
            entityId: productId,
            newValue: { name: v.name, categoryId: category.id, typeId: input.typeId ?? null, shopId, approvalStatus: owner ? "PENDING_APPROVAL" : "APPROVED" },
          },
          tx,
        );
      }
      const [listing] = await tx
        .insert(shopProducts)
        .values({
          shopId,
          productId,
          onlinePricePaise: price,
          offlinePricePaise: price,
          onlineSaleEnabled: price != null,
          offlineSaleEnabled: price != null,
          trackInventory: true,
          onlineStock: stock,
          offlineStock: 0,
          isActive: true,
          isAvailable: true,
        })
        .onConflictDoUpdate({
          target: [shopProducts.shopId, shopProducts.productId],
          set: { deletedAt: null, isActive: true, isAvailable: true, updatedAt: new Date() },
        })
        .returning({ id: shopProducts.id });
      if (stock > 0) {
        await tx.insert(inventoryMovements).values({
          shopProductId: listing.id,
          channel: "ONLINE",
          deltaUnits: stock,
          previousUnits: 0,
          newUnits: stock,
          reason: "New product (opening stock)",
          source: "puja_own_product",
          createdBy: actor.id,
        });
      }
      await recordAudit(
        { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PRODUCT_CREATED, entityType: "shop_product", entityId: listing.id, newValue: { productId, shopId } },
        tx,
      );
      out.push({ productId, listingId: listing.id, name: v.name, reused: Boolean(existing) });
    }
    return out;
  });
  await checkCommissionMilestonesSafely(shopId);
  return { created, similar };
}
