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
import { and, eq, inArray, sql } from "drizzle-orm";

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
  type Product,
  type ProductCategory,
  type Shop,
  type ShopProduct,
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

/** The most units one cart line holds — what the cart API takes and the product card offers. */
export const CART_LINE_MAX_QUANTITY = 99;

/**
 * The user's cart, created if need be, locked until the transaction ends.
 * Every add or quantity change (and a purchase list sent to the cart) takes
 * this lock before it reads a line, so two at once — a double tap, two tabs —
 * run one after the other: the second reads what the first wrote. Unlocked,
 * the second insert of a new line hit cart_items_cart_product_unique (500),
 * and two adds onto a line both wrote existing + quantity from one read (D-100).
 * Checkout takes it too, first in each shop's transaction (lockCartLinesForShop).
 */
export async function lockCart(userId: string, tx: DbClient): Promise<{ id: string }> {
  const cart = await getOrCreateCart(userId, tx);
  await tx.select({ id: carts.id }).from(carts).where(eq(carts.id, cart.id)).for("update");
  return cart;
}

export async function addToCart(
  userId: string,
  shopProductId: string,
  quantity = 1,
): Promise<CartSummary> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw validationFailed("Quantity must be a positive whole number.");
  }

  await db.transaction(async (tx) => {
    const cart = await lockCart(userId, tx);

    const existing = await tx.query.cartItems.findFirst({
      where: and(
        eq(cartItems.cartId, cart.id),
        eq(cartItems.shopProductId, shopProductId),
      ),
    });
    const already = existing?.quantity ?? 0;
    // Capped at what one line holds; a line already above it (added before the cap) is not cut back.
    const desiredQuantity = Math.max(already, Math.min(CART_LINE_MAX_QUANTITY, already + quantity));

    // Validate against the *total* quantity that would result, not just the delta.
    await assertPurchasableNow(shopProductId, desiredQuantity, tx);

    if (existing) {
      await tx
        .update(cartItems)
        .set({ quantity: desiredQuantity, updatedAt: new Date() })
        .where(eq(cartItems.id, existing.id));
    } else {
      await tx
        .insert(cartItems)
        .values({ cartId: cart.id, shopProductId, quantity: desiredQuantity });
    }
  });

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

  // Under the cart's lock too: an add running at the same time would otherwise write its stale
  // read + quantity over this change.
  await db.transaction(async (tx) => {
    const cart = await lockCart(userId, tx);

    const item = await tx.query.cartItems.findFirst({
      where: and(eq(cartItems.id, cartItemId), eq(cartItems.cartId, cart.id)),
    });
    if (!item) throw notFound("Cart item");

    if (quantity === 0) {
      await tx.delete(cartItems).where(eq(cartItems.id, cartItemId));
      return;
    }

    await assertPurchasableNow(item.shopProductId, quantity, tx);
    await tx
      .update(cartItems)
      .set({ quantity, updatedAt: new Date() })
      .where(eq(cartItems.id, cartItemId));
  });

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

/** A cart line as checkout reads it under the cart's lock. */
export interface LockedCartLine {
  id: string;
  shopProductId: string;
  quantity: number;
}

/**
 * One shop's lines in the user's cart, read under lockCart: what a checkout
 * orders from that shop and then removes (removeCartLines). An add after the
 * checkout's first read of the cart is in these lines; one from now on waits
 * for the checkout's transaction — so no unit leaves the cart unordered.
 */
export async function lockCartLinesForShop(
  userId: string,
  shopId: string,
  tx: DbClient,
): Promise<LockedCartLine[]> {
  const cart = await lockCart(userId, tx);
  return tx
    .select({ id: cartItems.id, shopProductId: cartItems.shopProductId, quantity: cartItems.quantity })
    .from(cartItems)
    .innerJoin(shopProducts, eq(cartItems.shopProductId, shopProducts.id))
    .where(and(eq(cartItems.cartId, cart.id), eq(shopProducts.shopId, shopId)));
}

/** Removes exactly these lines — the ones a checkout read under the cart's lock. */
export async function removeCartLines(cartItemIds: string[], tx: DbClient): Promise<void> {
  if (cartItemIds.length === 0) return;
  await tx.delete(cartItems).where(inArray(cartItems.id, cartItemIds));
}

/** Removes every line of one shop — the "cannot deliver here" resolution. */
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

  const priced = await priceLines(
    rows.map((row) => ({ lineId: row.item.id, quantity: row.item.quantity, sp: row.sp, product: row.product, category: row.category, shop: row.shop })),
  );
  return { cartId: cart.id, ...priced };
}

/** A line to price as the cart would: a cart line, or a purchase list's line before it goes to the cart. */
export interface LineToPrice {
  /** cart_items.id, or the purchase list item's id (returned as the line's cartItemId). */
  lineId: string;
  quantity: number;
  sp: ShopProduct;
  product: Product;
  category: ProductCategory;
  shop: Shop;
}

/**
 * Prices lines with live shop prices and offers, grouped by shop with each
 * shop's delivery fee — the cart's totals, and a purchase list's "check"
 * (docs/purchase-lists-2026-10), so the two can never disagree.
 */
export async function priceLines(rows: LineToPrice[]): Promise<Omit<CartSummary, "cartId">> {
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
      row.quantity,
    );

    const priced = priceWithOffers(
      row.sp.onlinePricePaise,
      { shopId: row.shop.id, shopProductId: row.sp.id, categoryId: row.product.categoryId },
      offers,
    );
    const unitPrice = priced.unitPricePaise ?? 0;
    const quantityMilli = row.quantity * row.product.unitSizeMilli;

    const line: CartLine = {
      cartItemId: row.lineId,
      shopProductId: row.sp.id,
      productName: row.product.name,
      categoryName: row.category.name,
      department: row.category.department,
      unit: row.product.unit,
      unitSizeMilli: row.product.unitSizeMilli,
      imageUrl: row.sp.imageUrl ?? row.product.imageUrl,
      quantity: row.quantity,
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
    groups,
    itemCount: rows.reduce((n, r) => n + r.quantity, 0),
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
  client: DbClient = db,
): Promise<void> {
  const [row] = await client
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

export function describeUnavailability(
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
