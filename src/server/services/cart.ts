/**
 * Cart service (requirement §17).
 *
 * The cart lives in the database, not the browser, so quantities and prices
 * cannot be tampered with client-side. Prices are never stored on the cart —
 * they are read live from `shop_products` at render and checkout time, so a
 * price change is always reflected before the customer pays.
 *
 * A cart may span several shops. Totals are therefore always computed *per
 * shop*, and checkout produces one order per shop (§17).
 */
import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { lineTotalPaise, sumPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  cartItems,
  carts,
  productCategories,
  products,
  shopProducts,
  shops,
  type Department,
  type Shop,
} from "@/server/db/schema";
import { assertOnlinePurchasable, isOnlinePurchasable } from "./catalogue";
import { getLiveOffers, priceWithOffers } from "./shop-offers";

export interface CartLine {
  cartItemId: string;
  shopProductId: string;
  productName: string;
  categoryName: string;
  department: Department;
  unit: string;
  unitSizeMilli: number;
  imageUrl: string | null;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  /** False when the item can no longer be bought online right now. */
  purchasable: boolean;
  unavailableReason: string | null;
  /** F8: set only when a shop offer lowered the price — the normal price and the offer's title. */
  listUnitPricePaise?: number;
  offerTitle?: string;
}

export interface CartShopGroup {
  shop: Pick<
    Shop,
    | "id"
    | "name"
    | "slug"
    | "classification"
    | "deliveryAvailable"
    | "deliveryFeePaise"
    | "freeDeliveryAbovePaise"
    | "status"
    | "openingHours"
  >;
  lines: CartLine[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface CartSummary {
  cartId: string;
  groups: CartShopGroup[];
  itemCount: number;
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxPaise: number;
  grandTotalPaise: number;
  hasUnavailableItems: boolean;
}

export async function getOrCreateCart(
  userId: string,
  client: DbClient = db,
): Promise<{ id: string }> {
  const existing = await client.query.carts.findFirst({
    where: eq(carts.userId, userId),
    columns: { id: true },
  });
  if (existing) return existing;

  await client.insert(carts).values({ userId }).onConflictDoNothing();
  const created = await client.query.carts.findFirst({
    where: eq(carts.userId, userId),
    columns: { id: true },
  });
  if (!created) throw notFound("Cart");
  return created;
}

export async function addToCart(
  userId: string,
  shopProductId: string,
  quantity = 1,
): Promise<CartSummary> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw validationFailed("Quantity must be a positive whole number.");
  }

  const cart = await getOrCreateCart(userId);

  const existing = await db.query.cartItems.findFirst({
    where: and(
      eq(cartItems.cartId, cart.id),
      eq(cartItems.shopProductId, shopProductId),
    ),
  });
  const desiredQuantity = (existing?.quantity ?? 0) + quantity;

  // Validate against the *total* quantity that would result, not just the delta.
  await assertPurchasableNow(shopProductId, desiredQuantity);

  if (existing) {
    await db
      .update(cartItems)
      .set({ quantity: desiredQuantity, updatedAt: new Date() })
      .where(eq(cartItems.id, existing.id));
  } else {
    await db
      .insert(cartItems)
      .values({ cartId: cart.id, shopProductId, quantity: desiredQuantity });
  }

  return getCart(userId);
}

export async function setCartItemQuantity(
  userId: string,
  cartItemId: string,
  quantity: number,
): Promise<CartSummary> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw validationFailed("Quantity must be a whole number.");
  }
  const cart = await getOrCreateCart(userId);

  const item = await db.query.cartItems.findFirst({
    where: and(eq(cartItems.id, cartItemId), eq(cartItems.cartId, cart.id)),
  });
  if (!item) throw notFound("Cart item");

  if (quantity === 0) {
    await db.delete(cartItems).where(eq(cartItems.id, cartItemId));
    return getCart(userId);
  }

  await assertPurchasableNow(item.shopProductId, quantity);
  await db
    .update(cartItems)
    .set({ quantity, updatedAt: new Date() })
    .where(eq(cartItems.id, cartItemId));

  return getCart(userId);
}

export async function removeCartItem(
  userId: string,
  cartItemId: string,
): Promise<CartSummary> {
  const cart = await getOrCreateCart(userId);
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.id, cartItemId), eq(cartItems.cartId, cart.id)));
  return getCart(userId);
}

export async function clearCart(
  userId: string,
  client: DbClient = db,
): Promise<void> {
  const cart = await getOrCreateCart(userId, client);
  await client.delete(cartItems).where(eq(cartItems.cartId, cart.id));
}

/** Removes only the lines belonging to one shop — used after a per-shop checkout. */
export async function clearCartForShop(
  userId: string,
  shopId: string,
  client: DbClient = db,
): Promise<void> {
  const cart = await getOrCreateCart(userId, client);
  const rows = await client
    .select({ id: cartItems.id })
    .from(cartItems)
    .innerJoin(shopProducts, eq(cartItems.shopProductId, shopProducts.id))
    .where(and(eq(cartItems.cartId, cart.id), eq(shopProducts.shopId, shopId)));

  for (const row of rows) {
    await client.delete(cartItems).where(eq(cartItems.id, row.id));
  }
}

/** A cart line as a product card needs it: which line, and how many. */
export interface CartLineQuantity {
  cartItemId: string;
  quantity: number;
}

/**
 * The user's cart quantities keyed by shop product, so a product card can
 * show its in-cart controls on first render rather than "Add to cart" for
 * something already in the cart. Read-only: unlike getCart, it never creates
 * a cart.
 */
export async function getCartLineQuantities(
  userId: string,
): Promise<Map<string, CartLineQuantity>> {
  const rows = await db
    .select({
      cartItemId: cartItems.id,
      shopProductId: cartItems.shopProductId,
      quantity: cartItems.quantity,
    })
    .from(cartItems)
    .innerJoin(carts, eq(cartItems.cartId, carts.id))
    .where(eq(carts.userId, userId));
  return new Map(
    rows.map((r) => [r.shopProductId, { cartItemId: r.cartItemId, quantity: r.quantity }]),
  );
}

/**
 * Units in the user's cart (getCart's itemCount) for the header badge: one
 * query rather than the full priced cart on every page. Never creates a cart.
 */
async function getCartItemCountUncached(userId: string): Promise<number> {
  const [row] = await db
    .select({ units: sql<number>`coalesce(sum(${cartItems.quantity}), 0)`.mapWith(Number) })
    .from(cartItems)
    .innerJoin(carts, eq(cartItems.cartId, carts.id))
    .where(eq(carts.userId, userId));
  return row?.units ?? 0;
}

/** Memoised for one server render (layout, header and board all ask); API routes and actions call straight through. */
export const getCartItemCount = cache(getCartItemCountUncached);

/**
 * Builds the full cart view, grouped by shop with live prices and per-shop
 * delivery fees. Unpurchasable lines are retained but flagged, so the customer
 * sees *why* something cannot be ordered rather than having it vanish (§53).
 */
export async function getCart(userId: string): Promise<CartSummary> {
  const cart = await getOrCreateCart(userId);

  const rows = await db
    .select({
      item: cartItems,
      sp: shopProducts,
      product: products,
      category: productCategories,
      shop: shops,
    })
    .from(cartItems)
    .innerJoin(shopProducts, eq(cartItems.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(cartItems.cartId, cart.id));

  const byShop = new Map<string, CartShopGroup>();
  // F8: live shop offers (none unless the rule is on) — checkout prices the same way.
  const offers = await getLiveOffers(rows.map((r) => r.shop.id));

  for (const row of rows) {
    const purchasable = isOnlinePurchasable(
      {
        shopStatus: row.shop.status,
        isActive: row.sp.isActive,
        isAvailable: row.sp.isAvailable,
        onlineSaleEnabled: row.sp.onlineSaleEnabled,
        onlinePricePaise: row.sp.onlinePricePaise,
        trackInventory: row.sp.trackInventory,
        onlineStock: row.sp.onlineStock,
      },
      row.item.quantity,
    );

    const priced = priceWithOffers(
      row.sp.onlinePricePaise,
      { shopId: row.shop.id, shopProductId: row.sp.id, categoryId: row.product.categoryId },
      offers,
    );
    const unitPrice = priced.unitPricePaise ?? 0;
    const quantityMilli = row.item.quantity * row.product.unitSizeMilli;

    const line: CartLine = {
      cartItemId: row.item.id,
      shopProductId: row.sp.id,
      productName: row.product.name,
      categoryName: row.category.name,
      department: row.category.department,
      unit: row.product.unit,
      unitSizeMilli: row.product.unitSizeMilli,
      imageUrl: row.sp.imageUrl ?? row.product.imageUrl,
      quantity: row.item.quantity,
      unitPricePaise: unitPrice,
      lineTotalPaise: unitPrice > 0 ? lineTotalPaise(unitPrice, quantityMilli) : 0,
      purchasable,
      unavailableReason: purchasable
        ? null
        : describeUnavailability(row.shop.status, row.sp),
      ...(priced.offer ? { listUnitPricePaise: row.sp.onlinePricePaise!, offerTitle: priced.offer.title } : {}),
    };

    let group = byShop.get(row.shop.id);
    if (!group) {
      group = {
        shop: {
          id: row.shop.id,
          name: row.shop.name,
          slug: row.shop.slug,
          classification: row.shop.classification,
          deliveryAvailable: row.shop.deliveryAvailable,
          deliveryFeePaise: row.shop.deliveryFeePaise,
          freeDeliveryAbovePaise: row.shop.freeDeliveryAbovePaise,
          status: row.shop.status,
          openingHours: row.shop.openingHours,
        },
        lines: [],
        subtotalPaise: 0,
        deliveryFeePaise: 0,
        taxPaise: 0,
        totalPaise: 0,
      };
      byShop.set(row.shop.id, group);
    }
    group.lines.push(line);
  }

  for (const group of byShop.values()) {
    group.subtotalPaise = sumPaise(
      group.lines.filter((l) => l.purchasable).map((l) => l.lineTotalPaise),
    );
    group.deliveryFeePaise = computeDeliveryFee(group.shop, group.subtotalPaise);
    // Dairy and bakery staples are zero-rated; the field exists so GST can be
    // introduced later without reshaping orders.
    group.taxPaise = 0;
    group.totalPaise =
      group.subtotalPaise + group.deliveryFeePaise + group.taxPaise;
  }

  const groups = [...byShop.values()].sort((a, b) =>
    a.shop.name.localeCompare(b.shop.name),
  );

  return {
    cartId: cart.id,
    groups,
    itemCount: rows.reduce((n, r) => n + r.item.quantity, 0),
    subtotalPaise: sumPaise(groups.map((g) => g.subtotalPaise)),
    deliveryFeePaise: sumPaise(groups.map((g) => g.deliveryFeePaise)),
    taxPaise: sumPaise(groups.map((g) => g.taxPaise)),
    grandTotalPaise: sumPaise(groups.map((g) => g.totalPaise)),
    hasUnavailableItems: groups.some((g) => g.lines.some((l) => !l.purchasable)),
  };
}

export function computeDeliveryFee(
  shop: Pick<
    Shop,
    "deliveryAvailable" | "deliveryFeePaise" | "freeDeliveryAbovePaise"
  >,
  subtotalPaise: number,
): number {
  if (!shop.deliveryAvailable || subtotalPaise === 0) return 0;
  if (
    shop.freeDeliveryAbovePaise != null &&
    subtotalPaise >= shop.freeDeliveryAbovePaise
  ) {
    return 0;
  }
  return shop.deliveryFeePaise;
}

async function assertPurchasableNow(
  shopProductId: string,
  quantity: number,
): Promise<void> {
  const [row] = await db
    .select({ sp: shopProducts, shopStatus: shops.status })
    .from(shopProducts)
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
    quantity,
  );
}

function describeUnavailability(
  shopStatus: string,
  sp: {
    isActive: boolean;
    isAvailable: boolean;
    onlineSaleEnabled: boolean;
    onlinePricePaise: number | null;
    trackInventory: boolean;
    onlineStock: number;
  },
): string {
  if (shopStatus !== "APPROVED") return "This shop is not accepting orders.";
  if (!sp.isActive) return "This product is no longer available.";
  if (!sp.onlineSaleEnabled || sp.onlinePricePaise == null) {
    return "Available only at the physical shop.";
  }
  if (!sp.isAvailable) return "Currently unavailable online.";
  if (sp.trackInventory && sp.onlineStock <= 0) return "Out of stock.";
  return `Only ${sp.onlineStock} left in stock.`;
}
