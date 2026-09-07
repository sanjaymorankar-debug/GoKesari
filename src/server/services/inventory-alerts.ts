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
  shopProducts,
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
  const [sp] = await client
    .select()
    .from(shopProducts)
    .where(eq(shopProducts.id, shopProductId));
  if (!sp || !sp.trackInventory) return;

  const status = stockStatus(sp.onlineStock, sp.lowStockThreshold);
  const reorder = needsReorder(sp.onlineStock, sp.reorderLevel);

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
    await client
      .insert(stockAlerts)
      .values({
        shopProductId,
        shopId: sp.shopId,
        alertType,
        stockAtAlert: sp.onlineStock,
        thresholdAtAlert:
          alertType === "REORDER" ? (sp.reorderLevel ?? 0) : sp.lowStockThreshold,
      })
      .onConflictDoNothing();
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
  const rows = await db
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));

  const dashboard: InventoryDashboard = {
    totalProducts: rows.length,
    inStock: 0,
    lowStock: 0,
    outOfStock: 0,
    reorderRequired: 0,
    inventoryValuePaise: 0,
  };

  for (const row of rows) {
    switch (stockStatus(row.onlineStock, row.lowStockThreshold)) {
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
    if (needsReorder(row.onlineStock, row.reorderLevel)) dashboard.reorderRequired += 1;
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
