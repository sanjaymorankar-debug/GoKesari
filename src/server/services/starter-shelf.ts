/**
 * Starter shelf (onboarding Phase B, G16 — docs/onboarding-benchmark/proposed-flow.md S6): a new
 * shop is never live and empty. Once it has chosen its categories, the products other shops in
 * those categories stock most are offered, already ticked, with the MRP as the price and the
 * default stock; the owner only changes what differs and publishes them in one go.
 *
 * Owner, 05-Nov-2026 (D2): 100 products, each shown with stock 100, the owner updates his own
 * quantity (rule starterShelf).
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { conflict, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { productCategories, products, shopCategories, shopCategoryMapping, shopProductCategories, shopProducts, shops } from "@/server/db/schema";
import { createShopProduct } from "./catalogue";
import { addCategoryToShop } from "./product-categories";
import { getRule } from "./settings";

export interface StarterShelfItem {
  productId: string;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  unit: string;
  kind: "PACKAGED" | "LOOSE";
  /** The printed MRP from the product master; null for loose goods. */
  mrpPaise: number | null;
}

export interface StarterShelf {
  enabled: boolean;
  defaultStock: number;
  items: StarterShelfItem[];
  /** Products the shop already lists (the shelf leaves them out). */
  listed: number;
}

/**
 * The product categories the shelf draws from: those the shop already carries, the catalogue
 * category of its shop type (seeded per type, department = the type), and those named like the
 * shop categories it chose on the wizard's Category step — the wizard sets shop categories,
 * which are a different list from product categories.
 */
async function shelfCategoryIds(shopId: string): Promise<string[]> {
  const [shop] = await db.select({ shopType: shops.shopType }).from(shops).where(eq(shops.id, shopId));
  if (!shop) return [];
  const carried = db.select({ id: shopProductCategories.categoryId }).from(shopProductCategories).where(eq(shopProductCategories.shopId, shopId));
  const chosenNames = db
    .select({ name: sql`lower(${shopCategories.name})` })
    .from(shopCategoryMapping)
    .innerJoin(shopCategories, eq(shopCategories.id, shopCategoryMapping.categoryId))
    .where(eq(shopCategoryMapping.shopId, shopId));
  const rows = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(
      and(
        isNull(productCategories.deletedAt),
        eq(productCategories.isActive, true),
        or(
          inArray(productCategories.id, carried),
          sql`${productCategories.department}::text = ${shop.shopType}`,
          inArray(sql`lower(${productCategories.name})`, chosenNames),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** The products offered to a shop: in its categories, not listed yet, most-stocked by other shops first. */
export async function getStarterShelf(shopId: string): Promise<StarterShelf> {
  const rule = await getRule("starterShelf");
  const [listedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  const listed = Number(listedRow?.n ?? 0);
  if (!rule.enabled) return { enabled: false, defaultStock: rule.defaultStock, items: [], listed };
  const categoryIds = await shelfCategoryIds(shopId);
  if (categoryIds.length === 0) return { enabled: true, defaultStock: rule.defaultStock, items: [], listed };

  // How many shops list each product: a fair "what sells here" without order data for a new shop.
  const stockedBy = sql<number>`(select count(*)::int from ${shopProducts} sp where sp.product_id = ${products.id} and sp.deleted_at is null)`;
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      categoryName: productCategories.name,
      imageUrl: products.imageUrl,
      unit: products.unit,
      kind: products.kind,
      mrpPaise: products.mrpPaise,
    })
    .from(products)
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .where(
      and(
        eq(products.isActive, true),
        isNull(products.deletedAt),
        eq(products.approvalStatus, "APPROVED"),
        inArray(products.categoryId, categoryIds),
        sql`not exists (select 1 from ${shopProducts} mine where mine.shop_id = ${shopId} and mine.product_id = ${products.id} and mine.deleted_at is null)`,
      ),
    )
    .orderBy(desc(stockedBy), sql`${products.imageUrl} is null`, products.name, products.id)
    .limit(rule.size);
  return { enabled: true, defaultStock: rule.defaultStock, items: rows, listed };
}

export interface StarterShelfPick {
  productId: string;
  pricePaise: number;
  stock: number;
}

/**
 * Lists the products the owner kept ticked, each on sale online and in the shop at the price
 * given, with that stock. One product that cannot be listed (a price above its MRP, a category
 * removed meanwhile) does not stop the others: it comes back with its reason.
 */
export async function publishStarterShelf(
  shopId: string,
  picks: StarterShelfPick[],
  actor: { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
): Promise<{ added: number; failed: { productId: string; reason: string }[]; firstProducts: boolean }> {
  const rule = await getRule("starterShelf");
  if (!rule.enabled) throw conflict("The starter shelf is switched off.");
  if (picks.length === 0) throw validationFailed("Tick at least one product.");
  if (picks.length > rule.size) throw validationFailed(`At most ${rule.size} products at a time.`);
  const [before] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));

  // Selling above the printed MRP is not allowed (Legal Metrology), whether or not the platform's
  // MRP rule is enforced for other listings.
  const picked = await db
    .select({ id: products.id, mrpPaise: products.mrpPaise, categoryId: products.categoryId })
    .from(products)
    .where(inArray(products.id, picks.map((p) => p.productId)));
  const mrps = new Map(picked.map((r) => [r.id, r.mrpPaise]));
  // A shop lists only products in categories it carries: link the shelf's categories first,
  // without the category's own auto-fill — only the ticked products are listed.
  const allowed = new Set(await shelfCategoryIds(shopId));
  for (const categoryId of new Set(picked.map((r) => r.categoryId))) {
    if (allowed.has(categoryId)) await addCategoryToShop(shopId, categoryId, actor, { fillInventory: false, reason: "starter shelf" });
  }

  let added = 0;
  const failed: { productId: string; reason: string }[] = [];
  for (const pick of picks) {
    const mrp = mrps.get(pick.productId);
    if (mrp != null && pick.pricePaise > mrp) {
      failed.push({ productId: pick.productId, reason: `The price is above the MRP (₹${(mrp / 100).toFixed(2)}).` });
      continue;
    }
    try {
      await createShopProduct(
        {
          shopId,
          productId: pick.productId,
          onlinePricePaise: pick.pricePaise,
          offlinePricePaise: pick.pricePaise,
          onlineSaleEnabled: true,
          offlineSaleEnabled: true,
          onlineStock: pick.stock,
          offlineStock: 0,
        },
        actor,
      );
      added += 1;
    } catch (error) {
      failed.push({ productId: pick.productId, reason: error instanceof Error ? error.message : "Could not be listed." });
    }
  }
  return { added, failed, firstProducts: Number(before?.n ?? 0) === 0 && added > 0 };
}
