/**
 * Starter shelf (onboarding Phase B, G16 — docs/onboarding-benchmark/proposed-flow.md S6): a new
 * shop is never live and empty. Once it has chosen its categories, the products other shops in
 * those categories stock most are offered, already ticked, with the MRP as the price and the
 * default stock; the owner only changes what differs and publishes them in one go.
 *
 * Owner, 05-Nov-2026 (D2): 100 products, each shown with stock 100, the owner updates his own
 * quantity (rule starterShelf). Owner, 05-Nov-2026 (Phase 2, Q1): "top" = ordered most on
 * GoKesari in the last 90 days, then stocked by most shops, then with a photo, then by name.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { conflict, validationFailed } from "@/lib/errors";
import { roundStock, stockQuantityProblem } from "@/lib/stock-quantity";
import { checkCommissionMilestonesSafely } from "@/server/dealers/commission";
import { db } from "@/server/db";
import {
  inventoryMovements,
  productCategories,
  products,
  shopCategories,
  shopCategoryMapping,
  shopProductCategories,
  shopProducts,
  shops,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { addCategoryToShop } from "./product-categories";
import { getRule } from "./settings";

/** The window that decides what sells (owner's Q1). */
const ORDER_WINDOW_DAYS = 90;
/** Orders that were really bought (as on the home page's "popular" lists). */
const PURCHASED_STATUSES = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"];

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

/** The products offered to a shop: in its categories, not listed yet, most-ordered (90 days) and most-stocked first. */
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

  // Orders of the product at any shop in the window (what sells), then how many shops list it
  // (what shops expect to sell) — a new shop has no orders of its own to go by.
  const since = new Date(Date.now() - ORDER_WINDOW_DAYS * 86_400_000);
  const ordered = sql<number>`(select count(distinct oi.order_id)::int from order_items oi
    join shop_products osp on osp.id = oi.shop_product_id
    join orders o on o.id = oi.order_id
    where osp.product_id = ${products.id} and o.created_at >= ${since.toISOString()}::timestamptz
      and o.status::text in (${sql.join(PURCHASED_STATUSES.map((s) => sql`${s}`), sql`, `)}))`;
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
    .orderBy(desc(ordered), desc(stockedBy), sql`${products.imageUrl} is null`, products.name, products.id)
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
 * given, with that stock (online, as an Excel upload does), in **one transaction**: the
 * categories are linked, every listing is written in one insert, and the opening stock goes to
 * the stock ledger. A product that cannot be listed (a price above its MRP, a stock figure its
 * kind does not allow, already listed, no longer available) is checked first and does not
 * stop the others: it comes back with its reason.
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
  // The same product ticked twice counts once (the last row wins).
  const byProduct = new Map(picks.map((p) => [p.productId, p]));

  // Any approved product in a live category: the shelf's own, or one the owner scanned (Phase 2,
  // WP2) — its category is linked to the shop below, as adding one product does.
  const picked = await db
    .select({ id: products.id, mrpPaise: products.mrpPaise, categoryId: products.categoryId, kind: products.kind })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(
      and(
        inArray(products.id, [...byProduct.keys()]),
        eq(products.isActive, true),
        isNull(products.deletedAt),
        eq(products.approvalStatus, "APPROVED"),
        eq(productCategories.isActive, true),
        isNull(productCategories.deletedAt),
      ),
    );
  const found = new Map(picked.map((r) => [r.id, r]));
  const existing = await db
    .select({ id: shopProducts.id, productId: shopProducts.productId, deletedAt: shopProducts.deletedAt })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.productId, [...byProduct.keys()])));
  const existingBy = new Map(existing.map((r) => [r.productId, r]));

  const failed: { productId: string; reason: string }[] = [];
  const valid: { pick: StarterShelfPick; categoryId: string; stock: number; removedRowId: string | null }[] = [];
  for (const pick of byProduct.values()) {
    const product = found.get(pick.productId);
    const listed = existingBy.get(pick.productId);
    // Selling above the printed MRP is not allowed (Legal Metrology), whether or not the
    // platform's MRP rule is enforced for other listings.
    const reason = !product
      ? "This product is no longer available."
      : listed && !listed.deletedAt
          ? "Already in your shop."
          : product.mrpPaise != null && pick.pricePaise > product.mrpPaise
            ? `The price is above the MRP (₹${(product.mrpPaise / 100).toFixed(2)}).`
            : stockQuantityProblem(pick.stock, product.kind, "Stock");
    if (reason || !product) {
      failed.push({ productId: pick.productId, reason: reason ?? "Could not be listed." });
      continue;
    }
    valid.push({ pick, categoryId: product.categoryId, stock: roundStock(pick.stock), removedRowId: listed?.id ?? null });
  }
  if (valid.length === 0) return { added: 0, failed, firstProducts: false };

  const { added, before } = await db.transaction(async (tx) => {
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
    // A shop lists only products in categories it carries: link the shelf's categories first,
    // without the category's own auto-fill — only the ticked products are listed.
    for (const categoryId of new Set(valid.map((v) => v.categoryId))) {
      await addCategoryToShop(shopId, categoryId, actor, { reason: "starter shelf" }, tx);
    }
    const listing = (v: (typeof valid)[number]) => ({
      onlinePricePaise: v.pick.pricePaise,
      offlinePricePaise: v.pick.pricePaise,
      onlineSaleEnabled: true,
      offlineSaleEnabled: true,
      trackInventory: true,
      onlineStock: v.stock,
      offlineStock: 0,
      isActive: true,
      isAvailable: true,
    });
    const rows: { id: string; productId: string; stock: number }[] = [];
    // A listing the shop removed earlier is brought back (past orders still point at its row).
    for (const v of valid.filter((x) => x.removedRowId)) {
      const [revived] = await tx
        .update(shopProducts)
        .set({ ...listing(v), deletedAt: null, updatedAt: new Date() })
        .where(and(eq(shopProducts.id, v.removedRowId!), sql`${shopProducts.deletedAt} IS NOT NULL`))
        .returning({ id: shopProducts.id, productId: shopProducts.productId });
      if (revived) rows.push({ ...revived, stock: v.stock });
    }
    const fresh = valid.filter((x) => !x.removedRowId);
    if (fresh.length) {
      const inserted = await tx
        .insert(shopProducts)
        .values(fresh.map((v) => ({ shopId, productId: v.pick.productId, ...listing(v) })))
        .onConflictDoNothing()
        .returning({ id: shopProducts.id, productId: shopProducts.productId });
      const stockOf = new Map(fresh.map((v) => [v.pick.productId, v.stock]));
      rows.push(...inserted.map((r) => ({ ...r, stock: stockOf.get(r.productId) ?? 0 })));
    }
    // The opening stock, so stock reports and the ledger agree (as the Excel upload does).
    const opening = rows.filter((r) => r.stock > 0);
    if (opening.length) {
      await tx.insert(inventoryMovements).values(
        opening.map((r) => ({
          shopProductId: r.id,
          channel: "ONLINE" as const,
          deltaUnits: r.stock,
          previousUnits: 0,
          newUnits: r.stock,
          reason: "Starter shelf (opening stock)",
          source: "starter_shelf",
          createdBy: actor.id,
        })),
      );
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.STARTER_SHELF_PUBLISHED,
        entityType: "shop",
        entityId: shopId,
        newValue: { listed: rows.length, productIds: rows.map((r) => r.productId) },
      },
      tx,
    );
    return { added: rows.length, before: Number(count?.n ?? 0) };
  });
  // docs/dealer-programme: a growing catalogue may complete the dealer's "verified + catalogue" milestone.
  if (added > 0) await checkCommissionMilestonesSafely(shopId);
  return { added, failed, firstProducts: before === 0 && added > 0 };
}
