/**
 * Reads that span the seller and customer databases (docs/db-split-2026-10):
 * the order and its lines from the customer database, the shop and products
 * from the seller database, joined here by their shared UUIDs. In
 * single/shadow mode both reads hit the same database, so the result is the
 * same as a SQL join.
 */
import { eq, inArray } from "drizzle-orm";

import { orderItems, orders, products, shopProducts, shops } from "@/server/db/schema";
import { customerDb, sellerDb } from "./clients";

export interface OrderWithShopAndProducts {
  order: typeof orders.$inferSelect;
  shop: Pick<typeof shops.$inferSelect, "id" | "name" | "slug" | "status" | "ownerId"> | null;
  items: {
    item: typeof orderItems.$inferSelect;
    shopProduct: Pick<typeof shopProducts.$inferSelect, "id" | "shopId" | "productId"> | null;
    product: Pick<typeof products.$inferSelect, "id" | "name"> | null;
  }[];
  /** Links that point at a missing seller row — should always be empty. */
  brokenLinks: string[];
}

export async function getOrderWithShopAndProducts(orderId: string): Promise<OrderWithShopAndProducts | null> {
  const customer = customerDb();
  const seller = sellerDb();
  const [order] = await customer.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const items = await customer.select().from(orderItems).where(eq(orderItems.orderId, orderId));

  const [shop] = await seller
    .select({ id: shops.id, name: shops.name, slug: shops.slug, status: shops.status, ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, order.shopId));
  const spIds = [...new Set(items.map((i) => i.shopProductId).filter((v): v is string => Boolean(v)))];
  const sps = spIds.length
    ? await seller.select({ id: shopProducts.id, shopId: shopProducts.shopId, productId: shopProducts.productId }).from(shopProducts).where(inArray(shopProducts.id, spIds))
    : [];
  const productIds = [...new Set(sps.map((s) => s.productId))];
  const prods = productIds.length ? await seller.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds)) : [];

  const spById = new Map(sps.map((s) => [s.id, s]));
  const productById = new Map(prods.map((p) => [p.id, p]));
  const brokenLinks: string[] = [];
  if (!shop) brokenLinks.push(`orders.shop_id ${order.shopId}`);
  const lines = items.map((item) => {
    const sp = item.shopProductId ? (spById.get(item.shopProductId) ?? null) : null;
    if (item.shopProductId && !sp) brokenLinks.push(`order_items.shop_product_id ${item.shopProductId}`);
    if (sp && sp.shopId !== order.shopId) brokenLinks.push(`order_items.shop_product_id ${sp.id} belongs to shop ${sp.shopId}`);
    const product = sp ? (productById.get(sp.productId) ?? null) : null;
    if (sp && !product) brokenLinks.push(`shop_products.product_id ${sp.productId}`);
    return { item, shopProduct: sp, product };
  });
  return { order, shop: shop ?? null, items: lines, brokenLinks };
}
