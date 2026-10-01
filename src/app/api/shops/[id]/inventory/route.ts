/**
 * A shop's inventory: dashboard counts, every listing with available / reserved /
 * on-hand stock and its effective thresholds, open alerts, and the shop-wide defaults.
 *   GET
 *   PATCH { lowStockThreshold?, reorderLevel?, reorderQuantity? }  — the shop's default thresholds
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import {
  getInventoryDashboard,
  listInventory,
  listStockAlerts,
  setShopStockDefaults,
} from "@/server/services/inventory-alerts";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const [shop] = await db.select().from(shops).where(eq(shops.id, id));
  if (!shop) throw notFound("Shop");
  const [dashboard, rows, alerts] = await Promise.all([getInventoryDashboard(id), listInventory(id), listStockAlerts(id)]);
  return ok({
    dashboard,
    rows,
    alerts,
    shopDefaults: {
      lowStockThreshold: shop.defaultLowStockThreshold,
      reorderLevel: shop.defaultReorderLevel,
      reorderQuantity: shop.defaultReorderQuantity,
    },
  });
});

const schema = z.object({
  lowStockThreshold: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).nullish(),
  reorderQuantity: z.number().int().positive().nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  await setShopStockDefaults(id, await parseBody(request, schema), user);
  return ok({ saved: true });
});
