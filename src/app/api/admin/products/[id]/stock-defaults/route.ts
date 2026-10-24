/**
 * Product-wide stock-alert defaults (catalogue staff): apply in every shop that sells
 * the product unless that listing sets its own.
 * PATCH { lowStockThreshold?, reorderLevel?, reorderQuantity? }  (null clears one)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_STOCK_UNITS, STOCK_MAX_MESSAGE } from "@/lib/price-rules";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { setProductStockDefaults } from "@/server/services/inventory-alerts";

// Bounded like stock itself: 99,999,999 used to be saved (TC-FLD-062/063).
const schema = z.object({
  lowStockThreshold: z.number().int().min(0).max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
  reorderLevel: z.number().int().min(0).max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
  reorderQuantity: z.number().int().min(0).max(MAX_STOCK_UNITS, STOCK_MAX_MESSAGE).nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MANAGE);
  const { id } = await context.params;
  await setProductStockDefaults(id, await parseBody(request, schema), user);
  return ok({ saved: true });
});
