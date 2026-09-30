/**
 * Product-wide stock-alert defaults (catalogue staff): apply in every shop that sells
 * the product unless that listing sets its own.
 * PATCH { lowStockThreshold?, reorderLevel?, reorderQuantity? }  (null clears one)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { setProductStockDefaults } from "@/server/services/inventory-alerts";

const schema = z.object({
  lowStockThreshold: z.number().int().min(0).nullish(),
  reorderLevel: z.number().int().min(0).nullish(),
  reorderQuantity: z.number().int().min(0).nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MANAGE);
  const { id } = await context.params;
  await setProductStockDefaults(id, await parseBody(request, schema), user);
  return ok({ saved: true });
});
