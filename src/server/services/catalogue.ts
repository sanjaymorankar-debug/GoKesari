/**
 * Catalogue service — categories, master products, and per-shop offerings
 * (requirements §7, §11–§14).
 *
 * The single most important function here is `assertOnlinePurchasable`. It is
 * the one authority on whether something may be bought online, and it is called
 * on add-to-cart, at checkout, and on every subscription order generation.
 * Nothing bypasses it.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";

import {
  conflict,
  forbidden,
  notFound,
  notPurchasableOnline,
  outOfStock,
  validationFailed,
} from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  inventoryMovements,
  productCategories,
  productPriceHistory,
  products,
  shopProducts,
  shops,
  type Department,
  type Product,
  type ProductApprovalStatus,
  type ProductCategory,
  type ShopProduct,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { evaluateStockAlerts } from "./inventory-alerts";

/* ------------------------------------------------------------ categories */

export async function listCategories(
  department?: Department,
): Promise<ProductCategory[]> {
  return db
    .select()
    .from(productCategories)
    .where(
      and(
        eq(productCategories.isActive, true),
        isNull(productCategories.deletedAt),
        department ? eq(productCategories.department, department) : undefined,
      ),
    )
    .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));
}

export async function createCategory(
  input: {
    department: Department;
    name: string;
    description?: string;
    imageUrl?: string;
    sortOrder?: number;
  },
  actor: { id: string; role: "OPERATOR" | "ADMIN" },
): Promise<ProductCategory> {
  const slug = slugify(input.name);
  const existing = await db.query.productCategories.findFirst({
    where: eq(productCategories.slug, slug),
  });
  if (existing) throw conflict("A category with that name already exists.");

  const [category] = await db
    .insert(productCategories)
    .values({ ...input, slug })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CATEGORY_CREATED,
    entityType: "product_category",
    entityId: category.id,
    newValue: { name: category.name, department: category.department },
  });
  return category;
}

/* -------------------------------------------------- master catalogue */

export async function listProducts(options: {
  department?: Department;
  categoryId?: string;
  subscribableOnly?: boolean;
  /**
   * Defaults to APPROVED — the safe choice for every public/search-facing
   * caller. A product a shop owner creates starts PENDING_APPROVAL and must
   * stay invisible to every OTHER shop's search until an admin publishes it;
   * only the admin approval queue passes "PENDING_APPROVAL" explicitly.
   */
  approvalStatus?: ProductApprovalStatus;
}): Promise<(Product & { category: ProductCategory })[]> {
  const rows = await db
    .select({ product: products, category: productCategories })
    .from(products)
    .innerJoin(
      productCategories,
      eq(products.categoryId, productCategories.id),
    )
    .where(
      and(
        eq(products.isActive, true),
        isNull(products.deletedAt),
        eq(products.approvalStatus, options.approvalStatus ?? "APPROVED"),
        options.department
          ? eq(productCategories.department, options.department)
          : undefined,
        options.categoryId ? eq(products.categoryId, options.categoryId) : undefined,
        options.subscribableOnly ? eq(products.subscribable, true) : undefined,
      ),
    )
    .orderBy(asc(products.name));

  return rows.map((r) => ({ ...r.product, category: r.category }));
}

/**
 * Products a shop of the given type is likely to sell (requirement §9).
 * Used to pre-populate the shop owner's catalogue picker; the owner still
 * chooses which of these they actually stock. APPROVED-only (see listProducts).
 */
export async function suggestProductsForShopType(
  shopType: Department,
): Promise<(Product & { category: ProductCategory })[]> {
  return listProducts({ department: shopType });
}

/* --------------------------------------- shop-owner / admin product creation */

function normaliseProductName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Classic edit-distance, used only for short product names so O(n·m) is fine. */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => [
    i,
    ...Array(cols - 1).fill(0),
  ]);
  for (let j = 1; j < cols; j += 1) d[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[rows - 1][cols - 1];
}

/**
 * "Check whether a similar/existing product already exists" (product
 * management brief, items 5–6). Two products in the SAME category with
 * near-identical normalised names are almost certainly the same thing typed
 * twice — an exact match is reused outright; a close match is surfaced as a
 * warning rather than silently created or silently blocked.
 */
export async function findSimilarProducts(
  name: string,
  categoryId: string,
  client: DbClient = db,
): Promise<{ exact: Product | null; similar: Product[] }> {
  const target = normaliseProductName(name);
  if (!target) return { exact: null, similar: [] };

  const candidates = await client
    .select()
    .from(products)
    .where(
      and(
        eq(products.categoryId, categoryId),
        isNull(products.deletedAt),
        ne(products.approvalStatus, "REJECTED"),
      ),
    );

  let exact: Product | null = null;
  const similar: Product[] = [];

  for (const candidate of candidates) {
    const candidateName = normaliseProductName(candidate.name);
    if (candidateName === target) {
      exact = candidate;
      continue;
    }
    // Short names tolerate less absolute distance than long ones.
    const threshold = Math.max(1, Math.floor(Math.min(target.length, candidateName.length) * 0.25));
    if (
      levenshtein(target, candidateName) <= threshold ||
      candidateName.includes(target) ||
      target.includes(candidateName)
    ) {
      similar.push(candidate);
    }
  }
  return { exact, similar };
}

export interface CreateProductForShopInput {
  shopId: string;
  categoryId: string;
  name: string;
  description?: string | null;
  specifications?: string | null;
  subCategory?: string | null;
  unit: string;
  unitSizeMilli?: number;
  subscribable?: boolean;
  imageUrl?: string | null;
  onlinePricePaise?: number | null;
  offlinePricePaise?: number | null;
  onlineSaleEnabled?: boolean;
  offlineSaleEnabled?: boolean;
  isAvailable?: boolean;
  /** Proceed even though a similar product was found (from a prior preview call). */
  confirmDuplicate?: boolean;
}

/**
 * Creates a brand-new master product and attaches it to one shop — the
 * function behind both the manual "Create New Product" form and a GOODS Excel
 * row that matches nothing existing.
 *
 * Architecture preserved deliberately: this still writes to `products` (the
 * shared central catalogue) and `shop_products` (the per-shop offering) as two
 * separate rows, exactly like every other product in the system — there is no
 * parallel "shop-owner product" table. What is new is who may create the
 * `products` row and what its initial `approvalStatus` is.
 *
 * @param applyPriceImmediately Whether the submitted price may go live on
 *   `shop_products` directly, or must be withheld pending the shop owner's
 *   approval — computed by the caller via `appliesImmediately()` from
 *   price-requests.ts. Kept as a plain boolean parameter (not imported here)
 *   so this file never depends on price-requests.ts, avoiding a cycle: that
 *   file already imports `updateShopProduct` from here.
 */
export async function createProductForShop(
  input: CreateProductForShopInput,
  actor: { id: string; role: UserRole },
  applyPriceImmediately: boolean,
  client?: DbClient,
): Promise<{
  product: Product;
  shopProduct: ShopProduct;
  reusedExisting: boolean;
  similarWarning: Product[];
}> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw validationFailed("Product name must be at least 2 characters.");
  }
  if (!input.unit.trim()) {
    throw validationFailed("Unit is required.");
  }

  const lookupClient = client ?? db;
  const category = await lookupClient.query.productCategories.findFirst({
    where: and(
      eq(productCategories.id, input.categoryId),
      isNull(productCategories.deletedAt),
    ),
  });
  if (!category) throw notFound("Category");

  validatePricing({
    onlineSaleEnabled: input.onlineSaleEnabled ?? false,
    offlineSaleEnabled: input.offlineSaleEnabled ?? false,
    onlinePricePaise: input.onlinePricePaise,
    offlinePricePaise: input.offlinePricePaise,
  });

  const { exact, similar } = await findSimilarProducts(
    name,
    input.categoryId,
    lookupClient,
  );

  // An exact name match in the same category IS this product — reuse it
  // rather than create a duplicate row, exactly as item 5 asks.
  if (exact) {
    const shopProduct = await createShopProduct(
      {
        shopId: input.shopId,
        productId: exact.id,
        description: input.description,
        imageUrl: input.imageUrl,
        onlinePricePaise: applyPriceImmediately ? input.onlinePricePaise : null,
        offlinePricePaise: applyPriceImmediately ? input.offlinePricePaise : null,
        onlineSaleEnabled: applyPriceImmediately
          ? (input.onlineSaleEnabled ?? false)
          : false,
        offlineSaleEnabled: applyPriceImmediately
          ? (input.offlineSaleEnabled ?? false)
          : false,
        isAvailable: input.isAvailable,
      },
      actor as { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
      lookupClient,
    );
    return {
      product: exact,
      shopProduct,
      reusedExisting: true,
      similarWarning: [],
    };
  }

  if (similar.length > 0 && !input.confirmDuplicate) {
    throw conflict(
      `This looks similar to an existing product: ${similar
        .map((p) => p.name)
        .join(", ")}. Resubmit with confirmDuplicate to create it anyway.`,
    );
  }

  const run = async (tx: DbClient) => {
    const [product] = await tx
      .insert(products)
      .values({
        categoryId: input.categoryId,
        name,
        slug: uniqueSlug(name),
        description: input.description ?? null,
        specifications: input.specifications ?? null,
        subCategory: input.subCategory ?? null,
        imageUrl: input.imageUrl ?? null,
        unit: input.unit.trim(),
        unitSizeMilli: input.unitSizeMilli ?? 1000,
        subscribable: input.subscribable ?? false,
        // A SHOP_OWNER's product must not be discoverable by other shops until
        // an admin publishes it; OPERATOR/ADMIN already hold that trust.
        approvalStatus: actor.role === "SHOP_OWNER" ? "PENDING_APPROVAL" : "APPROVED",
        createdBy: actor.id,
      })
      .returning();

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.GLOBAL_PRODUCT_CREATED,
        entityType: "product",
        entityId: product.id,
        newValue: {
          name: product.name,
          categoryId: product.categoryId,
          approvalStatus: product.approvalStatus,
          shopId: input.shopId,
        },
      },
      tx,
    );

    const [shopProduct] = await tx
      .insert(shopProducts)
      .values({
        shopId: input.shopId,
        productId: product.id,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        onlinePricePaise: applyPriceImmediately ? (input.onlinePricePaise ?? null) : null,
        offlinePricePaise: applyPriceImmediately ? (input.offlinePricePaise ?? null) : null,
        onlineSaleEnabled: applyPriceImmediately
          ? (input.onlineSaleEnabled ?? false)
          : false,
        offlineSaleEnabled: applyPriceImmediately
          ? (input.offlineSaleEnabled ?? false)
          : false,
        isActive: true,
        isAvailable: input.isAvailable ?? true,
      })
      .returning();

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_CREATED,
        entityType: "shop_product",
        entityId: shopProduct.id,
        newValue: {
          productId: product.id,
          shopId: input.shopId,
          pending: !applyPriceImmediately,
        },
      },
      tx,
    );

    return { product, shopProduct, reusedExisting: false, similarWarning: similar };
  };

  return client ? run(client) : db.transaction(run);
}

export async function listPendingProductApprovals(): Promise<
  (Product & { category: ProductCategory; createdByName: string | null })[]
> {
  const rows = await db
    .select({
      product: products,
      category: productCategories,
      createdByName: sql<string | null>`(SELECT name FROM users WHERE users.id = ${products.createdBy})`,
    })
    .from(products)
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .where(eq(products.approvalStatus, "PENDING_APPROVAL"))
    .orderBy(desc(products.createdAt));

  return rows.map((r) => ({ ...r.product, category: r.category, createdByName: r.createdByName }));
}

/** Publishes a shop-owner-created product to the central catalogue. ADMIN only. */
export async function approveProduct(
  productId: string,
  actor: { id: string; role: UserRole },
): Promise<Product> {
  const current = await db.query.products.findFirst({
    where: eq(products.id, productId),
  });
  if (!current) throw notFound("Product");
  if (current.approvalStatus !== "PENDING_APPROVAL") {
    throw conflict("This product has already been decided.");
  }

  const [updated] = await db
    .update(products)
    .set({ approvalStatus: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), rejectionReason: null })
    .where(eq(products.id, productId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_APPROVED,
    entityType: "product",
    entityId: productId,
    previousValue: { approvalStatus: "PENDING_APPROVAL" },
    newValue: { approvalStatus: "APPROVED" },
  });
  return updated;
}

export async function rejectProduct(
  productId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Product> {
  const current = await db.query.products.findFirst({
    where: eq(products.id, productId),
  });
  if (!current) throw notFound("Product");
  if (current.approvalStatus !== "PENDING_APPROVAL") {
    throw conflict("This product has already been decided.");
  }

  const [updated] = await db
    .update(products)
    .set({
      approvalStatus: "REJECTED",
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: reason,
    })
    .where(eq(products.id, productId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_REJECTED,
    entityType: "product",
    entityId: productId,
    previousValue: { approvalStatus: "PENDING_APPROVAL" },
    newValue: { approvalStatus: "REJECTED", reason },
  });
  return updated;
}

/* ------------------------------------------------ shop-product offerings */

export interface ShopProductDetail extends ShopProduct {
  product: Product;
  category: ProductCategory;
}

export async function getShopProduct(
  shopProductId: string,
  client: DbClient = db,
): Promise<ShopProductDetail | undefined> {
  const [row] = await client
    .select({ sp: shopProducts, product: products, category: productCategories })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .where(eq(shopProducts.id, shopProductId))
    .limit(1);

  if (!row) return undefined;
  return { ...row.sp, product: row.product, category: row.category };
}

/** Product counts per shop, for the admin "Shop Product Management" list. */
export async function countProductsByShop(
  shopIds: readonly string[],
): Promise<Record<string, number>> {
  if (shopIds.length === 0) return {};
  const rows = await db
    .select({
      shopId: shopProducts.shopId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(shopProducts)
    .where(and(inArray(shopProducts.shopId, [...shopIds]), isNull(shopProducts.deletedAt)))
    .groupBy(shopProducts.shopId);

  return Object.fromEntries(rows.map((r) => [r.shopId, r.count]));
}

export async function listShopProducts(
  shopId: string,
  options: { onlineOnly?: boolean } = {},
): Promise<ShopProductDetail[]> {
  const rows = await db
    .select({ sp: shopProducts, product: products, category: productCategories })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .where(
      and(
        eq(shopProducts.shopId, shopId),
        isNull(shopProducts.deletedAt),
        options.onlineOnly
          ? and(
              eq(shopProducts.isActive, true),
              eq(shopProducts.isAvailable, true),
              eq(shopProducts.onlineSaleEnabled, true),
            )
          : undefined,
      ),
    )
    .orderBy(asc(productCategories.sortOrder), asc(products.name));

  return rows.map((r) => ({ ...r.sp, product: r.product, category: r.category }));
}

export interface UpsertShopProductInput {
  shopId: string;
  productId: string;
  description?: string | null;
  imageUrl?: string | null;
  onlinePricePaise?: number | null;
  offlinePricePaise?: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  trackInventory?: boolean;
  onlineStock?: number;
  offlineStock?: number;
  isActive?: boolean;
  isAvailable?: boolean;
}

/**
 * Validates the online/offline pricing rules from §13 before touching the
 * database. The equivalent CHECK constraints are still in place as a backstop —
 * this layer exists to return a friendly message rather than a 500.
 */
function validatePricing(input: {
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  onlinePricePaise?: number | null;
  offlinePricePaise?: number | null;
}): void {
  if (input.onlineSaleEnabled && input.onlinePricePaise == null) {
    throw validationFailed(
      "An online price is required when online selling is enabled.",
    );
  }
  if (input.offlineSaleEnabled && input.offlinePricePaise == null) {
    throw validationFailed(
      "An offline price is required when offline selling is enabled.",
    );
  }
  for (const [label, value] of [
    ["Online price", input.onlinePricePaise],
    ["Offline price", input.offlinePricePaise],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      throw validationFailed(`${label} must be a whole, non-negative amount.`);
    }
  }
}

export async function createShopProduct(
  input: UpsertShopProductInput,
  actor: { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
  client: DbClient = db,
): Promise<ShopProduct> {
  validatePricing(input);

  const duplicate = await client.query.shopProducts.findFirst({
    where: and(
      eq(shopProducts.shopId, input.shopId),
      eq(shopProducts.productId, input.productId),
    ),
  });
  if (duplicate) {
    throw conflict("This product is already in your shop's catalogue.");
  }

  const [created] = await client
    .insert(shopProducts)
    .values({
      shopId: input.shopId,
      productId: input.productId,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      onlinePricePaise: input.onlinePricePaise ?? null,
      offlinePricePaise: input.offlinePricePaise ?? null,
      onlineSaleEnabled: input.onlineSaleEnabled,
      offlineSaleEnabled: input.offlineSaleEnabled,
      trackInventory: input.trackInventory ?? true,
      onlineStock: input.onlineStock ?? 0,
      offlineStock: input.offlineStock ?? 0,
      isActive: input.isActive ?? true,
      isAvailable: input.isAvailable ?? true,
    })
    .returning();

  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      entityType: "shop_product",
      entityId: created.id,
      newValue: {
        onlinePricePaise: created.onlinePricePaise,
        offlinePricePaise: created.offlinePricePaise,
        onlineSaleEnabled: created.onlineSaleEnabled,
      },
    },
    client,
  );
  return created;
}

/**
 * Updates a shop's offering. Price changes are recorded in
 * `product_price_history` inside the same transaction, so the trail can never
 * drift from the current value (§13).
 */
/**
 * @param client Pass the surrounding transaction when this runs as part of a
 *               larger unit of work — the price-approval flow applies an
 *               approved request and closes its batch atomically, so it must
 *               not open a second transaction here.
 */
export async function updateShopProduct(
  shopProductId: string,
  patch: Partial<Omit<UpsertShopProductInput, "shopId" | "productId">>,
  actor: { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
  client?: DbClient,
): Promise<ShopProduct> {
  const run = async (tx: DbClient) => {
    const [current] = await tx
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.id, shopProductId))
      .for("update");
    if (!current) throw notFound("Product");

    const next = {
      onlineSaleEnabled: patch.onlineSaleEnabled ?? current.onlineSaleEnabled,
      offlineSaleEnabled: patch.offlineSaleEnabled ?? current.offlineSaleEnabled,
      onlinePricePaise:
        patch.onlinePricePaise !== undefined
          ? patch.onlinePricePaise
          : current.onlinePricePaise,
      offlinePricePaise:
        patch.offlinePricePaise !== undefined
          ? patch.offlinePricePaise
          : current.offlinePricePaise,
    };
    validatePricing(next);

    const [updated] = await tx
      .update(shopProducts)
      .set({
        ...patch,
        ...next,
        updatedAt: new Date(),
      })
      .where(eq(shopProducts.id, shopProductId))
      .returning();

    // Price history — one row per changed channel.
    const priceChanges: {
      priceType: "ONLINE" | "OFFLINE";
      previous: number | null;
      next: number;
    }[] = [];

    if (
      next.onlinePricePaise != null &&
      next.onlinePricePaise !== current.onlinePricePaise
    ) {
      priceChanges.push({
        priceType: "ONLINE",
        previous: current.onlinePricePaise,
        next: next.onlinePricePaise,
      });
    }
    if (
      next.offlinePricePaise != null &&
      next.offlinePricePaise !== current.offlinePricePaise
    ) {
      priceChanges.push({
        priceType: "OFFLINE",
        previous: current.offlinePricePaise,
        next: next.offlinePricePaise,
      });
    }

    for (const change of priceChanges) {
      await tx.insert(productPriceHistory).values({
        shopProductId,
        priceType: change.priceType,
        previousPricePaise: change.previous,
        newPricePaise: change.next,
        changedBy: actor.id,
      });
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.PRODUCT_PRICE_CHANGED,
          entityType: "shop_product",
          entityId: shopProductId,
          previousValue: { [change.priceType]: change.previous },
          newValue: { [change.priceType]: change.next },
        },
        tx,
      );
    }

    const availabilityChanged =
      (patch.isAvailable !== undefined &&
        patch.isAvailable !== current.isAvailable) ||
      (patch.isActive !== undefined && patch.isActive !== current.isActive) ||
      next.onlineSaleEnabled !== current.onlineSaleEnabled;

    if (availabilityChanged) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.PRODUCT_AVAILABILITY_CHANGED,
          entityType: "shop_product",
          entityId: shopProductId,
          previousValue: {
            isActive: current.isActive,
            isAvailable: current.isAvailable,
            onlineSaleEnabled: current.onlineSaleEnabled,
          },
          newValue: {
            isActive: updated.isActive,
            isAvailable: updated.isAvailable,
            onlineSaleEnabled: updated.onlineSaleEnabled,
          },
        },
        tx,
      );
    }

    return updated;
  };

  return client ? run(client) : db.transaction(run);
}

/**
 * Removes a product from a shop's catalogue (§9 "remove products").
 * Soft-deletes rather than hard-deletes: past orders reference shop_products
 * via order_items and must keep resolving, so the row stays but stops
 * appearing anywhere it is listed or purchasable.
 */
export async function removeShopProduct(
  shopProductId: string,
  actor: { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
): Promise<void> {
  const [current] = await db
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.id, shopProductId), isNull(shopProducts.deletedAt)));
  if (!current) throw notFound("Product");

  await db
    .update(shopProducts)
    .set({
      deletedAt: new Date(),
      isActive: false,
      isAvailable: false,
      onlineSaleEnabled: false,
      offlineSaleEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(shopProducts.id, shopProductId));

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_AVAILABILITY_CHANGED,
    entityType: "shop_product",
    entityId: shopProductId,
    previousValue: { deletedAt: null },
    newValue: { deletedAt: new Date().toISOString(), removed: true },
  });
}

/* ------------------------------------------------ storefront queries */

export interface StorefrontProduct {
  shopProductId: string;
  productId: string;
  productName: string;
  categoryName: string;
  department: Department;
  unit: string;
  unitSizeMilli: number;
  imageUrl: string | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  onlineStock: number;
  subscribable: boolean;
  shopId: string;
  shopName: string;
  shopSlug: string;
  shopClassification: "KESARI" | "GREEN" | null;
}

/**
 * Products as customers browse them, joined across every approved shop.
 *
 * Only APPROVED shops and active offerings are included, so an unapproved
 * shop's catalogue can never leak into public listings (§8, §15).
 */
export async function listStorefrontProducts(options: {
  department?: Department;
  categoryId?: string;
  shopId?: string;
  /** Only these shops — e.g. the ones that deliver to the customer (serviceability.ts). */
  shopIds?: readonly string[];
  /** Only this catalogue product — every shop's offer of it (GS-021/022). */
  productId?: string;
  query?: string;
  subscribableOnly?: boolean;
  onlineOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<StorefrontProduct[]> {
  if (options.shopIds && options.shopIds.length === 0) return [];
  const conditions = [
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    eq(shopProducts.isActive, true),
    isNull(shopProducts.deletedAt),
    eq(products.isActive, true),
  ];

  if (options.department) {
    conditions.push(eq(productCategories.department, options.department));
  }
  if (options.categoryId) {
    conditions.push(eq(products.categoryId, options.categoryId));
  }
  if (options.shopId) conditions.push(eq(shopProducts.shopId, options.shopId));
  if (options.shopIds) conditions.push(inArray(shopProducts.shopId, [...options.shopIds]));
  if (options.productId) conditions.push(eq(shopProducts.productId, options.productId));
  if (options.subscribableOnly) conditions.push(eq(products.subscribable, true));
  if (options.onlineOnly) {
    conditions.push(eq(shopProducts.onlineSaleEnabled, true));
  }
  if (options.query) {
    const term = `%${options.query}%`;
    conditions.push(
      or(
        ilike(products.name, term),
        ilike(productCategories.name, term),
        ilike(shops.name, term),
        ilike(shops.area, term),
        eq(shops.pincode, options.query),
      )!,
    );
  }

  const rows = await db
    .select({
      sp: shopProducts,
      product: products,
      category: productCategories,
      shop: shops,
    })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(and(...conditions))
    .orderBy(asc(productCategories.sortOrder), asc(products.name))
    .limit(Math.min(options.limit ?? 24, 100))
    .offset(options.offset ?? 0);

  return rows.map((r) => ({
    shopProductId: r.sp.id,
    productId: r.product.id,
    productName: r.product.name,
    categoryName: r.category.name,
    department: r.category.department,
    unit: r.product.unit,
    unitSizeMilli: r.product.unitSizeMilli,
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
    shopSlug: r.shop.slug,
    shopClassification: r.shop.classification,
  }));
}

/* ------------------------------------------- online purchasability rules */

export interface PurchasabilityContext {
  shopStatus: string;
  isActive: boolean;
  isAvailable: boolean;
  onlineSaleEnabled: boolean;
  onlinePricePaise: number | null;
  trackInventory: boolean;
  onlineStock: number;
}

/**
 * The §14 rule, expressed once.
 *
 * `requiredUnits` is in whole sellable units; stock is tracked per unit.
 * Throws a specific, customer-readable error rather than a generic denial so
 * the UI can explain exactly why (§53).
 */
export function assertOnlinePurchasable(
  ctx: PurchasabilityContext,
  requiredUnits = 1,
): void {
  if (ctx.shopStatus !== "APPROVED") {
    throw notPurchasableOnline("This shop is not currently accepting orders.");
  }
  if (!ctx.isActive) {
    throw notPurchasableOnline("This product is no longer available.");
  }
  if (!ctx.onlineSaleEnabled) {
    throw notPurchasableOnline(
      "This product is currently available only at the physical shop.",
    );
  }
  if (ctx.onlinePricePaise == null) {
    throw notPurchasableOnline(
      "This product is not priced for online sale yet.",
    );
  }
  if (!ctx.isAvailable) {
    throw outOfStock("This product is currently unavailable online.");
  }
  if (ctx.trackInventory && ctx.onlineStock < requiredUnits) {
    throw outOfStock(
      ctx.onlineStock <= 0
        ? "This product is currently unavailable online."
        : `Only ${ctx.onlineStock} left in stock.`,
    );
  }
}

/** Non-throwing variant for list rendering. */
export function isOnlinePurchasable(
  ctx: PurchasabilityContext,
  requiredUnits = 1,
): boolean {
  try {
    assertOnlinePurchasable(ctx, requiredUnits);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads a shop product together with its shop status and asserts it can be
 * bought online right now. Returns the row and its authoritative online price —
 * callers must use this price, never one supplied by the client (§47).
 */
export async function loadPurchasableShopProduct(
  shopProductId: string,
  requiredUnits: number,
  client: DbClient = db,
): Promise<{
  shopProduct: ShopProduct;
  product: Product;
  shopId: string;
  unitPricePaise: number;
}> {
  const [row] = await client
    .select({ sp: shopProducts, product: products, shopStatus: shops.status })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(shopProducts.id, shopProductId))
    .limit(1);

  if (!row) throw notFound("Product");

  assertOnlinePurchasable(
    {
      shopStatus: row.shopStatus,
      isActive: row.sp.isActive,
      isAvailable: row.sp.isAvailable,
      onlineSaleEnabled: row.sp.onlineSaleEnabled,
      onlinePricePaise: row.sp.onlinePricePaise,
      trackInventory: row.sp.trackInventory,
      onlineStock: row.sp.onlineStock,
    },
    requiredUnits,
  );

  return {
    shopProduct: row.sp,
    product: row.product,
    shopId: row.sp.shopId,
    // Non-null: assertOnlinePurchasable already rejected a null price.
    unitPricePaise: row.sp.onlinePricePaise!,
  };
}

/* -------------------------------------------------------------- stock */

/**
 * Decrements online stock and appends to the movement ledger.
 * Uses a conditional UPDATE so two concurrent orders cannot both consume the
 * last unit — if the guard fails, no rows are updated and we raise.
 */
export async function consumeOnlineStock(
  shopProductId: string,
  units: number,
  reason: string,
  client: DbClient,
  orderId?: string,
): Promise<void> {
  const [current] = await client
    .select()
    .from(shopProducts)
    .where(eq(shopProducts.id, shopProductId));
  if (!current) throw notFound("Product");
  if (!current.trackInventory) return;

  const updated = await client
    .update(shopProducts)
    .set({
      onlineStock: sql`${shopProducts.onlineStock} - ${units}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(shopProducts.id, shopProductId),
        sql`${shopProducts.onlineStock} >= ${units}`,
      ),
    )
    .returning();

  if (updated.length === 0) {
    throw outOfStock("This product is currently unavailable online.");
  }

  await client.insert(inventoryMovements).values({
    shopProductId,
    channel: "ONLINE",
    deltaUnits: -units,
    previousUnits: current.onlineStock,
    newUnits: updated[0].onlineStock,
    reason,
    orderId: orderId ?? null,
  });

  // Inside the caller's transaction, so an alert can never outlive a
  // rolled-back order.
  await evaluateStockAlerts(shopProductId, client);
}

/**
 * `client` lets a caller compose this into an already-open transaction (e.g.
 * cancelOrder's restock-on-cancel, DEF-01) instead of opening a nested one —
 * same optional-client shape as consumeOnlineStock and applyWalletMutation.
 * Omit it for the original standalone behaviour (a shop owner manually
 * receiving stock).
 */
export async function restockOnline(
  shopProductId: string,
  units: number,
  reason: string,
  actorId: string,
  client?: DbClient,
): Promise<ShopProduct> {
  if (!Number.isInteger(units) || units <= 0) {
    throw validationFailed("Restock quantity must be a positive whole number.");
  }
  const run = async (tx: DbClient): Promise<ShopProduct> => {
    const [current] = await tx
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.id, shopProductId))
      .for("update");
    if (!current) throw notFound("Product");

    const [updated] = await tx
      .update(shopProducts)
      .set({
        onlineStock: current.onlineStock + units,
        updatedAt: new Date(),
      })
      .where(eq(shopProducts.id, shopProductId))
      .returning();

    await tx.insert(inventoryMovements).values({
      shopProductId,
      channel: "ONLINE",
      deltaUnits: units,
      previousUnits: current.onlineStock,
      newUnits: updated.onlineStock,
      reason,
      createdBy: actorId,
    });

    // Resolves any open LOW_STOCK/OUT_OF_STOCK alert and flips the line back
    // to available — §17's replenishment path, with nothing to re-enter.
    await evaluateStockAlerts(shopProductId, tx);
    return updated;
  };
  return client ? run(client) : db.transaction(run);
}

/* ------------------------------------------------------------- helpers */

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Appends a short random suffix so slugs stay unique across shops. */
export function uniqueSlug(value: string): string {
  return `${slugify(value)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Guard used by shop-owner routes: block editing another shop's product. */
export async function assertShopProductBelongsToShop(
  shopProductId: string,
  shopId: string,
): Promise<void> {
  const row = await db.query.shopProducts.findFirst({
    where: eq(shopProducts.id, shopProductId),
    columns: { shopId: true },
  });
  if (!row) throw notFound("Product");
  if (row.shopId !== shopId) {
    throw forbidden("This product does not belong to your shop.");
  }
}
