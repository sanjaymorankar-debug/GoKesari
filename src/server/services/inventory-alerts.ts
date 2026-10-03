/**
 * Stock thresholds, alerts and the inventory dashboard (Product Master /
 * Inventory brief §15–§18, §22).
 *
 * The stock ledger already existed (`inventory_movements`); what's new is
 * *reacting* to it. `evaluateStockAlerts` is called from inside whatever
 * transaction just moved stock, so an alert can never disagree with the
 * balance that caused it — if the order rolls back, so does the alert.
 *
 * Thresholds are per shop-product, never global: a shop shifting 200
 * packets of milk a day and one shifting 5 have nothing useful in common.
 * A threshold of 0 means "don't alert me on this line".
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  orderItems,
  orders,
  products,
  shopProducts,
  shops,
  stockAlerts,
  type ShopProduct,
  type StockAlert,
  type StockAlertType,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";

interface Actor {
  id: string;
  role: UserRole;
}

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

/** §15's derived status. Pure function so the UI and the alert engine can never disagree. */
export function stockStatus(stock: number, lowStockThreshold: number): StockStatus {
  if (stock <= 0) return "OUT_OF_STOCK";
  if (lowStockThreshold > 0 && stock <= lowStockThreshold) return "LOW_STOCK";
  return "IN_STOCK";
}

/** §18. Reorder is a separate signal from "low": a shop may want warning well before it runs dry. */
export function needsReorder(stock: number, reorderLevel: number | null): boolean {
  return reorderLevel != null && reorderLevel > 0 && stock <= reorderLevel;
}

export interface EffectiveThresholds {
  lowStock: number;
  reorderLevel: number | null;
  reorderQuantity: number | null;
  /** Where each value came from — shown in the UI so an owner knows what to change. */
  source: { lowStock: ThresholdSource; reorderLevel: ThresholdSource; reorderQuantity: ThresholdSource };
  alertsDisabled: boolean;
}
export type ThresholdSource = "LISTING" | "PRODUCT" | "SHOP" | "NONE";

/**
 * Which threshold applies to a listing: the listing's own value, else the
 * product's default (set by catalogue staff), else the shop's default.
 * A listing threshold of 0 means "inherit"; `stockAlertsDisabled` is the
 * explicit opt-out. Pure, so the alert engine and every screen agree.
 */
export function resolveThresholds(
  listing: Pick<ShopProduct, "lowStockThreshold" | "reorderLevel" | "reorderQuantity" | "stockAlertsDisabled">,
  product: { defaultLowStockThreshold: number | null; defaultReorderLevel: number | null; defaultReorderQuantity: number | null },
  shop: { defaultLowStockThreshold: number; defaultReorderLevel: number | null; defaultReorderQuantity: number | null },
): EffectiveThresholds {
  if (listing.stockAlertsDisabled) {
    return {
      lowStock: 0,
      reorderLevel: null,
      reorderQuantity: null,
      source: { lowStock: "NONE", reorderLevel: "NONE", reorderQuantity: "NONE" },
      alertsDisabled: true,
    };
  }
  const pick = <T extends number | null>(own: T, fromProduct: number | null, fromShop: number | null) => {
    if (own != null && own > 0) return { value: own as number, source: "LISTING" as ThresholdSource };
    if (fromProduct != null && fromProduct > 0) return { value: fromProduct, source: "PRODUCT" as ThresholdSource };
    if (fromShop != null && fromShop > 0) return { value: fromShop, source: "SHOP" as ThresholdSource };
    return { value: null, source: "NONE" as ThresholdSource };
  };
  const low = pick(listing.lowStockThreshold, product.defaultLowStockThreshold, shop.defaultLowStockThreshold);
  const level = pick(listing.reorderLevel, product.defaultReorderLevel, shop.defaultReorderLevel);
  const qty = pick(listing.reorderQuantity, product.defaultReorderQuantity, shop.defaultReorderQuantity);
  return {
    lowStock: low.value ?? 0,
    reorderLevel: level.value,
    reorderQuantity: qty.value,
    source: { lowStock: low.source, reorderLevel: level.source, reorderQuantity: qty.source },
    alertsDisabled: false,
  };
}

/**
 * Opens or resolves alerts to match the current stock level. Idempotent:
 * safe to call after every stock movement, and the partial unique index on
 * (shop_product_id, alert_type) WHERE status = 'OPEN' means a line sitting
 * below its threshold for a week produces one alert, not seven.
 *
 * Pass the surrounding transaction so the alert commits atomically with the
 * stock change that triggered it.
 */
export async function evaluateStockAlerts(
  shopProductId: string,
  client: DbClient = db,
): Promise<void> {
  const [row] = await client
    .select({ sp: shopProducts, shop: shops, product: products })
    .from(shopProducts)
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(eq(shopProducts.id, shopProductId));
  if (!row || !row.sp.trackInventory) return;
  const { sp, shop, product } = row;
  const effective = resolveThresholds(sp, product, shop);

  // An opted-out listing raises no alert at all, and any open one is closed below.
  const status = effective.alertsDisabled ? "IN_STOCK" : stockStatus(sp.onlineStock, effective.lowStock);
  const reorder = !effective.alertsDisabled && needsReorder(sp.onlineStock, effective.reorderLevel);

  const wanted: StockAlertType[] = [];
  if (status === "OUT_OF_STOCK") wanted.push("OUT_OF_STOCK");
  else if (status === "LOW_STOCK") wanted.push("LOW_STOCK");
  if (reorder) wanted.push("REORDER");

  const open = await client
    .select()
    .from(stockAlerts)
    .where(and(eq(stockAlerts.shopProductId, shopProductId), eq(stockAlerts.status, "OPEN")));

  // Close anything no longer true — §17's "replenished, so it's available again".
  for (const alert of open) {
    if (!wanted.includes(alert.alertType)) {
      await client
        .update(stockAlerts)
        .set({ status: "RESOLVED", resolvedAt: new Date() })
        .where(eq(stockAlerts.id, alert.id));
    }
  }

  // Open anything newly true. onConflictDoNothing covers the race where two
  // concurrent movements both cross the threshold.
  for (const alertType of wanted) {
    if (open.some((a) => a.alertType === alertType)) continue;
    const [created] = await client
      .insert(stockAlerts)
      .values({
        shopProductId,
        shopId: sp.shopId,
        alertType,
        stockAtAlert: sp.onlineStock,
        thresholdAtAlert: alertType === "REORDER" ? (effective.reorderLevel ?? 0) : effective.lowStock,
      })
      .onConflictDoNothing()
      .returning();
    // Only a newly opened alert notifies (one message per alert, ever) — a line that
    // stays below its mark does not repeat, and a lost race inserts nothing.
    if (created) {
      const suggestion =
        alertType === "REORDER" && effective.reorderQuantity ? ` Suggested reorder: ${effective.reorderQuantity}.` : "";
      await notify(
        {
          userId: shop.ownerId,
          type: NOTIFICATION_TYPES.STOCK_LOW,
          title:
            alertType === "OUT_OF_STOCK"
              ? `Out of stock: ${product.name}`
              : alertType === "REORDER"
                ? `Time to reorder: ${product.name}`
                : `Low stock: ${product.name}`,
          body: `${product.name} is down to ${sp.onlineStock} unit(s).${suggestion}`,
          actionUrl: "/shop/inventory",
          dedupeKey: `stock-alert:${created.id}`,
        },
        client,
      );
    }
  }

  // §17: zero stock makes the line unorderable, but the inventory record and
  // all its settings stay — restocking flips it back with nothing to re-enter.
  const shouldBeAvailable = sp.onlineStock > 0;
  if (sp.isAvailable !== shouldBeAvailable) {
    await client
      .update(shopProducts)
      .set({ isAvailable: shouldBeAvailable, updatedAt: new Date() })
      .where(eq(shopProducts.id, shopProductId));
  }
}

/**
 * Notifies the shop owner about alerts opened since they last looked.
 * Deliberately separate from evaluateStockAlerts: notification failures must
 * never roll back a customer's order.
 */
export async function notifyOpenStockAlerts(shopId: string, ownerUserId: string): Promise<void> {
  const rows = await db
    .select({
      alert: stockAlerts,
      productName: sql<string>`(select p.name from products p
        join shop_products sp on sp.product_id = p.id
        where sp.id = ${stockAlerts.shopProductId})`,
    })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.shopId, shopId), eq(stockAlerts.status, "OPEN")))
    .limit(20);

  for (const row of rows) {
    await notify({
      userId: ownerUserId,
      type: NOTIFICATION_TYPES.STOCK_LOW,
      title:
        row.alert.alertType === "OUT_OF_STOCK"
          ? `Out of stock: ${row.productName}`
          : `Low stock: ${row.productName}`,
      body: `${row.productName} is down to ${row.alert.stockAtAlert} unit(s).`,
      actionUrl: "/shop/inventory",
      // One notification per alert, ever — re-running this must not spam.
      dedupeKey: `stock-alert:${row.alert.id}`,
    });
  }
}

export async function setStockThresholds(
  shopProductId: string,
  input: {
    lowStockThreshold?: number;
    reorderLevel?: number | null;
    reorderQuantity?: number | null;
    minimumOrderQuantity?: number;
    maximumOrderQuantity?: number | null;
    stockAlertsDisabled?: boolean;
  },
  actor: Actor,
): Promise<ShopProduct> {
  const current = await db.query.shopProducts.findFirst({
    where: and(eq(shopProducts.id, shopProductId), isNull(shopProducts.deletedAt)),
  });
  if (!current) throw notFound("Shop product");

  const shop = await db.query.shops.findFirst({ where: (s, { eq: e }) => e(s.id, current.shopId) });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && actor.role !== "OPERATOR") {
    throw forbidden("This shop does not belong to you.");
  }

  if (input.lowStockThreshold != null && input.lowStockThreshold < 0) {
    throw validationFailed("Low-stock threshold cannot be negative.");
  }
  if (input.reorderQuantity != null && input.reorderQuantity <= 0) {
    throw validationFailed("Reorder quantity must be a positive number.");
  }
  if (
    input.minimumOrderQuantity != null &&
    input.maximumOrderQuantity != null &&
    input.maximumOrderQuantity < input.minimumOrderQuantity
  ) {
    throw validationFailed("Maximum order quantity cannot be less than the minimum.");
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(shopProducts)
      .set({
        ...(input.lowStockThreshold !== undefined
          ? { lowStockThreshold: input.lowStockThreshold }
          : {}),
        ...(input.reorderLevel !== undefined ? { reorderLevel: input.reorderLevel } : {}),
        ...(input.reorderQuantity !== undefined ? { reorderQuantity: input.reorderQuantity } : {}),
        ...(input.stockAlertsDisabled !== undefined ? { stockAlertsDisabled: input.stockAlertsDisabled } : {}),
        ...(input.minimumOrderQuantity !== undefined
          ? { minimumOrderQuantity: input.minimumOrderQuantity }
          : {}),
        ...(input.maximumOrderQuantity !== undefined
          ? { maximumOrderQuantity: input.maximumOrderQuantity }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(shopProducts.id, shopProductId))
      .returning();

    // A raised threshold can put an already-low line into alert immediately.
    await evaluateStockAlerts(shopProductId, tx);
    return row;
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STOCK_THRESHOLD_CHANGED,
    entityType: "shop_product",
    entityId: shopProductId,
    previousValue: {
      lowStockThreshold: current.lowStockThreshold,
      reorderLevel: current.reorderLevel,
    },
    newValue: {
      lowStockThreshold: updated.lowStockThreshold,
      reorderLevel: updated.reorderLevel,
    },
  });

  return updated;
}

export async function listStockAlerts(
  shopId: string,
  options: { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED"; limit?: number } = {},
): Promise<StockAlert[]> {
  return db
    .select()
    .from(stockAlerts)
    .where(
      and(
        eq(stockAlerts.shopId, shopId),
        eq(stockAlerts.status, options.status ?? "OPEN"),
      ),
    )
    .orderBy(sql`${stockAlerts.createdAt} DESC`)
    .limit(options.limit ?? 100);
}

export async function acknowledgeStockAlert(alertId: string, actor: Actor): Promise<StockAlert> {
  const alert = await db.query.stockAlerts.findFirst({ where: eq(stockAlerts.id, alertId) });
  if (!alert) throw notFound("Stock alert");

  const shop = await db.query.shops.findFirst({ where: (s, { eq: e }) => e(s.id, alert.shopId) });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && actor.role !== "OPERATOR") {
    throw forbidden("This alert does not belong to your shop.");
  }

  const [updated] = await db
    .update(stockAlerts)
    .set({ status: "ACKNOWLEDGED", acknowledgedBy: actor.id, acknowledgedAt: new Date() })
    .where(eq(stockAlerts.id, alertId))
    .returning();
  return updated;
}

export interface InventoryDashboard {
  totalProducts: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  reorderRequired: number;
  inventoryValuePaise: number;
}

/** §22. One pass over the shop's lines — the counts must always agree with stockStatus(). */
export async function getInventoryDashboard(shopId: string): Promise<InventoryDashboard> {
  const rows = (await listInventory(shopId)).map((r) => ({
    onlineStock: r.available,
    onlinePricePaise: r.onlinePricePaise,
    status: r.status,
    reorderNeeded: r.reorderNeeded,
  }));

  const dashboard: InventoryDashboard = {
    totalProducts: rows.length,
    inStock: 0,
    lowStock: 0,
    outOfStock: 0,
    reorderRequired: 0,
    inventoryValuePaise: 0,
  };

  for (const row of rows) {
    switch (row.status) {
      case "IN_STOCK":
        dashboard.inStock += 1;
        break;
      case "LOW_STOCK":
        dashboard.lowStock += 1;
        break;
      case "OUT_OF_STOCK":
        dashboard.outOfStock += 1;
        break;
    }
    if (row.reorderNeeded) dashboard.reorderRequired += 1;
    // Valued at the shop's own selling price — the only price it actually
    // realises. MRP would overstate a discounted shelf.
    dashboard.inventoryValuePaise += (row.onlinePricePaise ?? 0) * row.onlineStock;
  }

  return dashboard;
}

export async function countOpenAlerts(shopId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.shopId, shopId), eq(stockAlerts.status, "OPEN")));
  return row?.value ?? 0;
}

/** Order statuses in which the goods are committed to a customer and not yet handed over. */
const OPEN_ORDER_STATUSES = [
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
] as const;

export interface InventoryRow {
  shopProductId: string;
  productId: string;
  productCode: string;
  productName: string;
  unit: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  /** Sellable right now — checkout takes stock the moment an order is placed. */
  available: number;
  /** Units already committed to open orders (placed, not yet delivered). */
  reserved: number;
  /** Physically with the shop: available + reserved. */
  onHand: number;
  offlineStock: number;
  trackInventory: boolean;
  status: StockStatus;
  reorderNeeded: boolean;
  thresholds: EffectiveThresholds;
  /** The listing's own settings, for the edit form. */
  own: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null; stockAlertsDisabled: boolean };
  openAlerts: StockAlertType[];
}

/** Every live listing with stock, reservations, effective thresholds and any open alert. */
export async function listInventory(shopId: string): Promise<InventoryRow[]> {
  const rows = await db
    .select({ sp: shopProducts, shop: shops, product: products })
    .from(shopProducts)
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  if (rows.length === 0) return [];

  const reservedRows = await db
    .select({
      shopProductId: orderItems.shopProductId,
      milli: sql<number>`coalesce(sum(${orderItems.quantityMilli}), 0)::bigint`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.shopId, shopId),
        sql`${orders.status} IN (${sql.join(OPEN_ORDER_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        sql`${orderItems.fulfilmentStatus} <> 'REMOVED'`,
      ),
    )
    .groupBy(orderItems.shopProductId);
  const reservedMilli = new Map(reservedRows.map((r) => [r.shopProductId, Number(r.milli)]));

  const alertRows = await db
    .select({ shopProductId: stockAlerts.shopProductId, alertType: stockAlerts.alertType })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.shopId, shopId), eq(stockAlerts.status, "OPEN")));

  return rows.map(({ sp, shop, product }) => {
    const thresholds = resolveThresholds(sp, product, shop);
    const reserved = Math.round((reservedMilli.get(sp.id) ?? 0) / Math.max(1, product.unitSizeMilli));
    return {
      shopProductId: sp.id,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unit: product.unit,
      onlinePricePaise: sp.onlinePricePaise,
      offlinePricePaise: sp.offlinePricePaise,
      available: sp.onlineStock,
      reserved,
      onHand: sp.onlineStock + reserved,
      offlineStock: sp.offlineStock,
      trackInventory: sp.trackInventory,
      status: sp.trackInventory ? stockStatus(sp.onlineStock, thresholds.lowStock) : ("IN_STOCK" as StockStatus),
      reorderNeeded: !thresholds.alertsDisabled && needsReorder(sp.onlineStock, thresholds.reorderLevel),
      thresholds,
      own: {
        lowStockThreshold: sp.lowStockThreshold,
        reorderLevel: sp.reorderLevel,
        reorderQuantity: sp.reorderQuantity,
        stockAlertsDisabled: sp.stockAlertsDisabled,
      },
      openAlerts: alertRows.filter((a) => a.shopProductId === sp.id).map((a) => a.alertType),
    };
  });
}

/** The shop-wide defaults every listing inherits unless it (or its product) sets its own. */
export async function setShopStockDefaults(
  shopId: string,
  input: { lowStockThreshold?: number; reorderLevel?: number | null; reorderQuantity?: number | null },
  actor: Actor,
): Promise<void> {
  const shop = await db.query.shops.findFirst({ where: (s, { eq: e }) => e(s.id, shopId) });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && actor.role !== "OPERATOR") {
    throw forbidden("This shop does not belong to you.");
  }
  if (input.lowStockThreshold != null && (!Number.isInteger(input.lowStockThreshold) || input.lowStockThreshold < 0)) {
    throw validationFailed("Low-stock threshold must be a whole number, 0 or more.");
  }
  if (input.reorderLevel != null && (!Number.isInteger(input.reorderLevel) || input.reorderLevel < 0)) {
    throw validationFailed("Reorder level must be a whole number, 0 or more.");
  }
  if (input.reorderQuantity != null && (!Number.isInteger(input.reorderQuantity) || input.reorderQuantity <= 0)) {
    throw validationFailed("Reorder quantity must be a positive whole number.");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(shops)
      .set({
        ...(input.lowStockThreshold !== undefined ? { defaultLowStockThreshold: input.lowStockThreshold } : {}),
        ...(input.reorderLevel !== undefined ? { defaultReorderLevel: input.reorderLevel } : {}),
        ...(input.reorderQuantity !== undefined ? { defaultReorderQuantity: input.reorderQuantity } : {}),
        updatedAt: new Date(),
      })
      .where(eq(shops.id, shopId));
    // Re-evaluate every listing: a raised default can put lines into alert at once.
    const listings = await tx.select({ id: shopProducts.id }).from(shopProducts).where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
    for (const l of listings) await evaluateStockAlerts(l.id, tx);
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STOCK_THRESHOLD_CHANGED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { low: shop.defaultLowStockThreshold, level: shop.defaultReorderLevel, qty: shop.defaultReorderQuantity },
    newValue: input,
  });
}

/** Catalogue staff set a product's default for every shop that sells it. */
export async function setProductStockDefaults(
  productId: string,
  input: { lowStockThreshold?: number | null; reorderLevel?: number | null; reorderQuantity?: number | null },
  actor: Actor,
): Promise<void> {
  if (actor.role !== "ADMIN" && actor.role !== "OPERATOR") throw forbidden("Only catalogue staff can set product-wide defaults.");
  for (const [label, v] of [
    ["Low-stock threshold", input.lowStockThreshold],
    ["Reorder level", input.reorderLevel],
    ["Reorder quantity", input.reorderQuantity],
  ] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0)) throw validationFailed(`${label} must be a whole number, 0 or more.`);
  }
  const [current] = await db.select().from(products).where(eq(products.id, productId));
  if (!current) throw notFound("Product");
  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        ...(input.lowStockThreshold !== undefined ? { defaultLowStockThreshold: input.lowStockThreshold } : {}),
        ...(input.reorderLevel !== undefined ? { defaultReorderLevel: input.reorderLevel } : {}),
        ...(input.reorderQuantity !== undefined ? { defaultReorderQuantity: input.reorderQuantity } : {}),
      })
      .where(eq(products.id, productId));
    const listings = await tx.select({ id: shopProducts.id }).from(shopProducts).where(and(eq(shopProducts.productId, productId), isNull(shopProducts.deletedAt)));
    for (const l of listings) await evaluateStockAlerts(l.id, tx);
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STOCK_THRESHOLD_CHANGED,
    entityType: "product",
    entityId: productId,
    previousValue: { low: current.defaultLowStockThreshold, level: current.defaultReorderLevel, qty: current.defaultReorderQuantity },
    newValue: input,
  });
}
