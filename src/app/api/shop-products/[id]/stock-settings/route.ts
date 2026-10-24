/**
 * Stock-alert settings for one listing: low-stock threshold, reorder level and
 * quantity, order limits, and an explicit opt-out. A threshold of 0 inherits the
 * product default and then the shop default.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { MAX_STOCK_UNITS, STOCK_MAX_MESSAGE } from "@/lib/price-rules";
import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shopProducts } from "@/server/db/schema";
import { setStockThresholds } from "@/server/services/inventory-alerts";

// Bounded like stock itself: 99,999,999 used to be saved (TC-FLD-062/063).
const schema = z.object({
  lowStockThreshold: z.number().int().min(0).max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).optional(),
  reorderLevel: z.number().int().min(0).max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
  reorderQuantity: z.number().int().positive().max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
  minimumOrderQuantity: z.number().int().positive().max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).optional(),
  maximumOrderQuantity: z.number().int().positive().max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
  stockAlertsDisabled: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  // Signed in first: a guest gets 401 before the body or the record is read (TC-SEC-001).
  await requireUser();
  const { id } = await context.params;
  const [row] = await db.select({ shopId: shopProducts.shopId }).from(shopProducts).where(eq(shopProducts.id, id));
  if (!row) throw notFound("Product");
  const { user } = await requireShopAccess(row.shopId, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const updated = await setStockThresholds(id, await parseBody(request, schema), user);
  return ok({
    lowStockThreshold: updated.lowStockThreshold,
    reorderLevel: updated.reorderLevel,
    reorderQuantity: updated.reorderQuantity,
    stockAlertsDisabled: updated.stockAlertsDisabled,
  });
});
