/**
 * Referential integrity across the seller and customer databases
 * (docs/db-split-2026-10). PostgreSQL cannot enforce a foreign key from
 * orders (customer database) to shops (seller database), so these checks do
 * it in the service layer, against the database that owns the parent row.
 * Shared keys are the stable UUIDs: shop_id, shop_product_id, product_id,
 * order_id, user_id.
 *
 * Each check is cheap (a primary-key lookup) and is meant to run before the
 * child row is written. In single/shadow mode the database's own foreign keys
 * already guarantee the same thing, so these agree with them by construction.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { orders, shopProducts, shops, users } from "@/server/db/schema";
import { customerDb, sellerDb } from "./clients";

/** The shop exists and is not deleted (orders, ratings, disputes, invoices… point at it). */
export async function assertShopExists(shopId: string): Promise<void> {
  const [shop] = await sellerDb().select({ id: shops.id }).from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
}

/**
 * Every shop product exists and belongs to this shop — what order_items,
 * cart_items and subscriptions need before they are written.
 */
export async function assertShopProductsBelongToShop(shopId: string, shopProductIds: string[]): Promise<void> {
  const ids = [...new Set(shopProductIds)];
  if (ids.length === 0) return;
  const rows = await sellerDb()
    .select({ id: shopProducts.id, shopId: shopProducts.shopId })
    .from(shopProducts)
    .where(inArray(shopProducts.id, ids));
  const found = new Map(rows.map((r) => [r.id, r.shopId]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw notFound(`Product ${missing[0]}`);
  const foreign = ids.filter((id) => found.get(id) !== shopId);
  if (foreign.length) throw conflict("A product in this order belongs to a different shop.", { shopProductIds: foreign });
}

/** The order exists (shop wallet transactions, SLA events and suspension holds point at it). */
export async function assertOrderExists(orderId: string): Promise<void> {
  const [order] = await customerDb().select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
}

/** The user exists (shops.owner_id, KYC reviewer ids… point at users in the core database). */
export async function assertUserExists(userId: string): Promise<void> {
  const [user] = await customerDb().select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound("User");
}
