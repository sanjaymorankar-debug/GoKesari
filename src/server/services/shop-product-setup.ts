/**
 * "Set up your shop's products": choose categories → pick products → set stock
 * and price (docs/shop-product-setup-2026-11). Choosing a category never lists
 * anything; a picked product waits as Needs Stock until the owner gives it a
 * quantity, and quantities on existing listings are changed only on request.
 */
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { AppError, notFound, validationFailed } from "@/lib/errors";
import { likePattern } from "@/lib/like-pattern";
import { listingStatus, type ListingStatus } from "@/lib/listing-status";
import { MAX_PRICE_PAISE } from "@/lib/price-rules";
import { roundStock, stockQuantityProblem, type ProductKind } from "@/lib/stock-quantity";
import { db, type DbClient } from "@/server/db";
import { checkCommissionMilestonesSafely } from "@/server/dealers/commission";
import {
  brands,
  productCategories,
  products,
  shopListingDetails,
  shopProductSetup,
  shopProducts,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { updateShopProduct } from "./catalogue";
import { getImportLimits } from "./product-import";
import { addCategoryToShop, assertCanManageShopCategories, shopCarriesProductCategory } from "./product-categories";

export interface SetupActor {
  id: string;
  role: UserRole;
}

type ListingActor = { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" };

/** "500 g" from the printed net quantity, else "1 kg" from the unit size. */
export function packSizeLabel(p: { netQuantity: number | null; netQuantityUnit: string | null; unit: string; unitSizeMilli: number }): string {
  if (p.netQuantity != null && p.netQuantityUnit) return `${p.netQuantity} ${p.netQuantityUnit}`;
  return `${p.unitSizeMilli / 1000} ${p.unit}`;
}

const masterLive = and(isNull(products.deletedAt), eq(products.isActive, true), eq(products.approvalStatus, "APPROVED"));

/* ------------------------------------------------------------- progress */

export async function getSetupProgress(shopId: string, client: DbClient = db): Promise<{ step: 1 | 2 | 3; newProductsSeenAt: Date | null }> {
  const [row] = await client.select().from(shopProductSetup).where(eq(shopProductSetup.shopId, shopId));
  return { step: (row?.step ?? 1) as 1 | 2 | 3, newProductsSeenAt: row?.newProductsSeenAt ?? null };
}

export async function saveSetupStep(
  shopId: string,
  step: 1 | 2 | 3,
  actor: SetupActor,
  client: DbClient = db,
  options: { seenNewProducts?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const seen = options.seenNewProducts ? { newProductsSeenAt: now } : {};
  await client
    .insert(shopProductSetup)
    .values({ shopId, step, updatedBy: actor.id, updatedAt: now, ...seen })
    .onConflictDoUpdate({ target: shopProductSetup.shopId, set: { step, updatedBy: actor.id, updatedAt: now, ...seen } });
}

/* ----------------------------------------------------- step 1: categories */

export interface CategoryTile {
  id: string;
  name: string;
  imageUrl: string | null;
  productCount: number;
  selected: boolean;
}

export async function listCategoryTiles(shopId: string): Promise<CategoryTile[]> {
  const carried = sql<boolean>`${shopCarriesProductCategory(shopId, productCategories.id)}`;
  const rows = await db
    .select({
      id: productCategories.id,
      name: productCategories.name,
      imageUrl: productCategories.imageUrl,
      productCount: sql<number>`(SELECT count(*)::int FROM products p
        WHERE p.category_id = product_categories.id AND p.deleted_at IS NULL
          AND p.is_active AND p.approval_status = 'APPROVED')`,
      selected: carried,
    })
    .from(productCategories)
    .where(and(isNull(productCategories.deletedAt), or(eq(productCategories.isActive, true), carried)))
    .orderBy(asc(productCategories.name));
  return rows;
}

/** Adds the chosen categories. Never lists a product and never removes a category (removal is confirmed one by one). */
export async function chooseCategories(shopId: string, categoryIds: string[], actor: SetupActor): Promise<{ added: number }> {
  await assertCanManageShopCategories(shopId, actor);
  if (categoryIds.length === 0) throw validationFailed("Choose at least one category.");
  return db.transaction(async (tx) => {
    let added = 0;
    for (const id of new Set(categoryIds)) {
      if ((await addCategoryToShop(shopId, id, actor, { reason: "product_setup" }, tx)).added) added += 1;
    }
    await saveSetupStep(shopId, 2, actor, tx);
    return { added };
  });
}

/* ------------------------------------------------------ step 2: products */

export interface PickerFilters {
  query?: string;
  categoryId?: string;
  newOnly?: boolean;
}

function notListed(shopId: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${shopProducts} sp WHERE sp.shop_id = ${shopId}
    AND sp.product_id = ${products.id} AND sp.deleted_at IS NULL)`;
}

/** Added to the master after the shop took the category and after the owner last looked. */
function isNewProduct(shopId: string): SQL {
  return sql`${products.createdAt} > GREATEST(
    (SELECT spc.created_at FROM shop_product_categories spc WHERE spc.shop_id = ${shopId} AND spc.category_id = ${products.categoryId}),
    COALESCE((SELECT s.new_products_seen_at FROM shop_product_setup s WHERE s.shop_id = ${shopId}), '-infinity'::timestamptz))`;
}

function pickerWhere(shopId: string, filters: PickerFilters) {
  const q = filters.query?.trim();
  const term = q ? likePattern(q) : null;
  return and(
    masterLive,
    shopCarriesProductCategory(shopId, products.categoryId),
    filters.categoryId ? eq(products.categoryId, filters.categoryId) : undefined,
    term ? or(ilike(products.name, term), ilike(products.code, term), ilike(brands.name, term)) : undefined,
    filters.newOnly ? and(isNewProduct(shopId), notListed(shopId)) : undefined,
  );
}

export interface PickerProduct {
  id: string;
  code: string;
  name: string;
  brandName: string | null;
  packSize: string;
  unit: string;
  kind: ProductKind;
  mrpPaise: number | null;
  imageUrl: string | null;
  categoryId: string;
  categoryName: string;
  alreadyAdded: boolean;
  isNew: boolean;
}

export async function listPickerProducts(
  shopId: string,
  filters: PickerFilters & { offset?: number; limit?: number },
): Promise<{ products: PickerProduct[]; total: number }> {
  const where = pickerWhere(shopId, filters);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: products.id,
        code: products.code,
        name: products.name,
        brandName: brands.name,
        netQuantity: products.netQuantity,
        netQuantityUnit: products.netQuantityUnit,
        unit: products.unit,
        unitSizeMilli: products.unitSizeMilli,
        kind: products.kind,
        mrpPaise: products.mrpPaise,
        imageUrl: products.imageUrl,
        categoryId: productCategories.id,
        categoryName: productCategories.name,
        alreadyAdded: sql<boolean>`NOT ${notListed(shopId)}`,
        isNew: sql<boolean>`COALESCE(${isNewProduct(shopId)}, false)`,
      })
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(where)
      .orderBy(asc(productCategories.name), asc(products.name), asc(products.id))
      .limit(Math.min(filters.limit ?? 50, 100))
      .offset(filters.offset ?? 0),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(where),
  ]);
  return {
    products: rows.map(({ netQuantity, netQuantityUnit, unitSizeMilli, ...r }) => ({
      ...r,
      packSize: packSizeLabel({ netQuantity, netQuantityUnit, unit: r.unit, unitSizeMilli }),
    })),
    total: count?.n ?? 0,
  };
}

/** Every product matching the filters that the shop does not have yet — "Select all". */
export async function listPickerIds(shopId: string, filters: PickerFilters): Promise<string[]> {
  const { maxRows } = await getImportLimits();
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(pickerWhere(shopId, filters), notListed(shopId)))
    .orderBy(asc(products.id))
    .limit(maxRows);
  return rows.map((r) => r.id);
}

export async function countNewProducts(shopId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(masterLive, shopCarriesProductCategory(shopId, products.categoryId), isNewProduct(shopId), notListed(shopId)));
  return row?.n ?? 0;
}

const INSERT_BATCH = 500;

/**
 * Lists the picked products as Needs Stock (Needs Price too for loose goods
 * and products with no MRP). A product the shop already has is left exactly as
 * it is; one it removed earlier comes back with its old stock and price.
 */
export async function addPickedProducts(
  shopId: string,
  productIds: string[],
  actor: SetupActor,
): Promise<{ added: number; alreadyAdded: number }> {
  await assertCanManageShopCategories(shopId, actor);
  const ids = [...new Set(productIds)];
  if (ids.length === 0) throw validationFailed("Select at least one product.");
  const { maxRows } = await getImportLimits();
  if (ids.length > maxRows) throw validationFailed(`You can add up to ${maxRows.toLocaleString("en-IN")} products at a time.`);

  return db.transaction(async (tx) => {
    const eligible = await tx
      .select({ id: products.id, kind: products.kind, mrpPaise: products.mrpPaise })
      .from(products)
      .where(and(inArray(products.id, ids), masterLive, shopCarriesProductCategory(shopId, products.categoryId)));
    const existing = await tx
      .select({ id: shopProducts.id, productId: shopProducts.productId, deletedAt: shopProducts.deletedAt })
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.productId, ids)));
    const have = new Map(existing.map((e) => [e.productId, e]));
    const fresh = eligible.filter((p) => !have.has(p.id));
    const removed = existing.filter((e) => e.deletedAt).map((e) => e.id);

    let added = 0;
    for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
      const batch = await tx
        .insert(shopProducts)
        .values(
          fresh.slice(i, i + INSERT_BATCH).map((p) => {
            const pricePaise = p.kind === "LOOSE" ? null : p.mrpPaise;
            return {
              shopId,
              productId: p.id,
              onlinePricePaise: pricePaise,
              offlinePricePaise: pricePaise,
              onlineSaleEnabled: pricePaise != null,
              offlineSaleEnabled: pricePaise != null,
              onlineStock: 0,
              offlineStock: 0,
              stockPending: true,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: shopProducts.id });
      added += batch.length;
    }
    if (removed.length) {
      const revived = await tx
        .update(shopProducts)
        .set({
          deletedAt: null,
          isActive: true,
          isAvailable: true,
          ownerPaused: false,
          onlineSaleEnabled: sql`${shopProducts.onlinePricePaise} IS NOT NULL`,
          offlineSaleEnabled: sql`${shopProducts.offlinePricePaise} IS NOT NULL`,
          stockPending: sql`${shopProducts.onlineStock} <= 0 AND ${shopProducts.offlineStock} <= 0`,
          updatedAt: new Date(),
        })
        .where(and(inArray(shopProducts.id, removed), eq(shopProducts.shopId, shopId)))
        .returning({ id: shopProducts.id });
      added += revived.length;
    }
    await saveSetupStep(shopId, 3, actor, tx, { seenNewProducts: true });
    if (added) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.PRODUCT_CREATED,
          entityType: "shop",
          entityId: shopId,
          newValue: { source: "product_setup", added },
        },
        tx,
      );
    }
    return { added, alreadyAdded: existing.length - removed.length };
  });
}

/* ------------------------------------------------- step 3 and My products */

export interface ListingRow {
  shopProductId: string;
  productId: string;
  code: string;
  name: string;
  brandName: string | null;
  packSize: string;
  unit: string;
  kind: ProductKind;
  categoryId: string;
  categoryName: string;
  imageUrl: string | null;
  masterMrpPaise: number | null;
  shopMrpPaise: number | null;
  pricePaise: number | null;
  /** Null while the listing waits for its first quantity. */
  stock: number | null;
  onlineStock: number;
  ownerPaused: boolean;
  status: ListingStatus;
}

export async function listShopListings(shopId: string, options: { shopProductIds?: string[] } = {}): Promise<ListingRow[]> {
  const rows = await db
    .select({
      sp: shopProducts,
      code: products.code,
      name: products.name,
      brandName: brands.name,
      netQuantity: products.netQuantity,
      netQuantityUnit: products.netQuantityUnit,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
      kind: products.kind,
      categoryId: productCategories.id,
      categoryName: productCategories.name,
      productImage: products.imageUrl,
      masterMrpPaise: products.mrpPaise,
      shopMrpPaise: shopListingDetails.mrpPaise,
      categoryCarried: sql<boolean>`${shopCarriesProductCategory(shopProducts.shopId, products.categoryId)}`,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(
      and(
        eq(shopProducts.shopId, shopId),
        isNull(shopProducts.deletedAt),
        options.shopProductIds ? inArray(shopProducts.id, options.shopProductIds) : undefined,
      ),
    )
    .orderBy(asc(productCategories.name), asc(products.name), asc(shopProducts.id));
  return rows.map((r) => {
    const status = listingStatus({ ...r.sp, categoryCarried: r.categoryCarried });
    return {
      shopProductId: r.sp.id,
      productId: r.sp.productId,
      code: r.code,
      name: r.name,
      brandName: r.brandName,
      packSize: packSizeLabel(r),
      unit: r.unit,
      kind: r.kind,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      imageUrl: r.sp.imageUrl ?? r.productImage,
      masterMrpPaise: r.masterMrpPaise,
      shopMrpPaise: r.shopMrpPaise,
      pricePaise: r.sp.onlinePricePaise ?? r.sp.offlinePricePaise,
      stock: status === "NEEDS_STOCK" ? null : r.sp.onlineStock,
      onlineStock: r.sp.onlineStock,
      ownerPaused: r.sp.ownerPaused,
      status,
    };
  });
}

/** The figures a listing's new price and quantity must satisfy; null when they are fine. */
export function listingValueProblem(input: {
  kind: ProductKind;
  pricePaise?: number | null;
  stock?: number | null;
  mrpPaise?: number | null;
}): string | null {
  if (input.stock != null) {
    const problem = stockQuantityProblem(input.stock, input.kind, "Stock");
    if (problem) return problem;
  }
  if (input.pricePaise != null) {
    if (!Number.isInteger(input.pricePaise) || input.pricePaise <= 0) return "Price must be more than 0.";
    if (input.pricePaise > MAX_PRICE_PAISE) return "A price can be at most ₹10,00,000.";
    if (input.mrpPaise != null && input.pricePaise > input.mrpPaise) return "Selling price cannot be more than the MRP.";
  }
  return null;
}

/** A shop's own MRP. It lives on the shop's listing, so the master and other shops never see it. */
export async function setShopMrp(shopProductId: string, shopId: string, mrpPaise: number, actor: SetupActor, client: DbClient): Promise<void> {
  const now = new Date();
  await client
    .insert(shopListingDetails)
    .values({ shopProductId, shopId, mrpPaise, updatedBy: actor.id })
    .onConflictDoUpdate({ target: shopListingDetails.shopProductId, set: { mrpPaise, updatedBy: actor.id, updatedAt: now } });
}

export interface ListingEdit {
  shopProductId: string;
  pricePaise?: number | null;
  stock?: number | null;
  shopMrpPaise?: number | null;
  expectedOnlineStock?: number;
}

export interface ListingSaveResult {
  live: number;
  needsStockOrPrice: number;
  outOfStock: number;
  paused: number;
  errors: { shopProductId: string; message: string }[];
}

/**
 * Saves the owner's figures. "live" applies price and quantity; "skip" keeps
 * any price typed but applies no quantity, so the row stays Needs Stock. A
 * blank leaves that figure as it is, and a bad row never stops the others.
 */
export async function saveListingEdits(
  shopId: string,
  edits: ListingEdit[],
  action: "live" | "skip",
  actor: SetupActor,
): Promise<ListingSaveResult> {
  await assertCanManageShopCategories(shopId, actor);
  const ids = edits.map((e) => e.shopProductId);
  const owned = ids.length
    ? await db
        .select({
          id: shopProducts.id,
          kind: products.kind,
          masterMrpPaise: products.mrpPaise,
          shopMrpPaise: shopListingDetails.mrpPaise,
        })
        .from(shopProducts)
        .innerJoin(products, eq(products.id, shopProducts.productId))
        .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
        .where(and(inArray(shopProducts.id, ids), eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
    : [];
  const byId = new Map(owned.map((o) => [o.id, o]));

  const errors: ListingSaveResult["errors"] = [];
  for (const edit of edits) {
    const row = byId.get(edit.shopProductId);
    if (!row) {
      errors.push({ shopProductId: edit.shopProductId, message: "This product is not in your shop." });
      continue;
    }
    const stock = action === "live" ? edit.stock : undefined;
    const mrpPaise = edit.shopMrpPaise ?? row.shopMrpPaise ?? (row.kind === "PACKAGED" ? row.masterMrpPaise : null);
    const problem =
      listingValueProblem({ kind: row.kind, pricePaise: edit.pricePaise, stock, mrpPaise }) ??
      (edit.shopMrpPaise != null && (!Number.isInteger(edit.shopMrpPaise) || edit.shopMrpPaise <= 0) ? "MRP must be more than 0." : null);
    if (problem) {
      errors.push({ shopProductId: edit.shopProductId, message: problem });
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        if (edit.shopMrpPaise != null) await setShopMrp(edit.shopProductId, shopId, edit.shopMrpPaise, actor, tx);
        const patch: Parameters<typeof updateShopProduct>[1] = {};
        if (edit.pricePaise != null) {
          patch.onlinePricePaise = edit.pricePaise;
          patch.offlinePricePaise = edit.pricePaise;
          patch.onlineSaleEnabled = true;
          patch.offlineSaleEnabled = true;
        }
        if (stock != null) patch.onlineStock = roundStock(stock);
        if (Object.keys(patch).length) {
          await updateShopProduct(edit.shopProductId, patch, actor as ListingActor, tx, {
            expectedOnlineStock: stock != null ? edit.expectedOnlineStock : undefined,
          });
        }
        if (stock != null) {
          await tx.update(shopProducts).set({ stockPending: false, updatedAt: new Date() }).where(eq(shopProducts.id, edit.shopProductId));
        }
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      errors.push({ shopProductId: edit.shopProductId, message: error.message });
    }
  }

  const statuses = ids.length ? await listShopListings(shopId, { shopProductIds: ids }) : [];
  const count = (...s: ListingStatus[]) => statuses.filter((l) => s.includes(l.status)).length;
  if (count("LIVE") > 0) await checkCommissionMilestonesSafely(shopId);
  return {
    live: count("LIVE"),
    needsStockOrPrice: count("NEEDS_STOCK", "NEEDS_PRICE"),
    outOfStock: count("OUT_OF_STOCK"),
    paused: count("PAUSED"),
    errors,
  };
}

/** The owner stops or restarts selling a listing. Stock and price are kept; only restarting needs stock to go live. */
export async function setListingPaused(shopId: string, shopProductId: string, paused: boolean, actor: SetupActor, client: DbClient = db): Promise<void> {
  await assertCanManageShopCategories(shopId, actor, client);
  const [row] = await client
    .update(shopProducts)
    .set({
      ownerPaused: paused,
      isAvailable: paused ? false : sql`${shopProducts.onlineStock} > 0 OR NOT ${shopProducts.trackInventory}`,
      updatedAt: new Date(),
    })
    .where(and(eq(shopProducts.id, shopProductId), eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
    .returning({ id: shopProducts.id });
  if (!row) throw notFound("Product");
}

/** Everything the page needs to decide where to open. */
export async function getSetupOverview(shopId: string) {
  const [progress, tiles, newProducts, listings] = await Promise.all([
    getSetupProgress(shopId),
    listCategoryTiles(shopId),
    countNewProducts(shopId),
    listShopListings(shopId),
  ]);
  return {
    step: progress.step,
    carried: tiles.filter((t) => t.selected).length,
    tiles,
    newProducts,
    listings,
  };
}
