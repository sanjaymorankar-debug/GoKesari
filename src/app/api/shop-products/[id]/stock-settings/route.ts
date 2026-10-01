/**
 * Stock-alert settings for one listing: low-stock threshold, reorder level and
 * quantity, order limits, and an explicit opt-out. A threshold of 0 inherits the
 * product default and then the shop default.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shopProducts } from "@/server/db/schema";
import { setStockThresholds } from "@/server/services/inventory-alerts";

const schema = z.object({
  lowStockThreshold: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).nullish(),
  reorderQuantity: z.number().int().positive().nullish(),
  minimumOrderQuantity: z.number().int().positive().optional(),
  maximumOrderQuantity: z.number().int().positive().nullish(),
  stockAlertsDisabled: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
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
