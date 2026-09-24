/**
 * "Add Existing Product" search — the central catalogue, scoped to the shop's
 * own department and already-listed products excluded, APPROVED-only (a
 * PENDING_APPROVAL product created by another shop stays invisible here, which
 * is the entire point of the approval gate).
 */
import type { NextRequest } from "next/server";

import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shopProducts, shops } from "@/server/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { listProducts } from "@/server/services/catalogue";

export const dynamic = "force-dynamic";

export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });
    enforceRateLimit(`catalogue-search:${user.id}`, RATE_LIMITS.MUTATION);

    const [shop] = await db
      .select({ shopType: shops.shopType })
      .from(shops)
      .where(eq(shops.id, id))
      .limit(1);
    if (!shop) return ok({ products: [] });

    const q = new URL(request.url).searchParams.get("q")?.trim().toLowerCase();

    const [catalogue, alreadyListed] = await Promise.all([
      listProducts({ department: shop.shopType }),
      db
        .select({ productId: shopProducts.productId })
        .from(shopProducts)
        .where(and(eq(shopProducts.shopId, id), isNull(shopProducts.deletedAt))),
    ]);

    const listed = new Set(alreadyListed.map((r) => r.productId));
    const available = catalogue.filter(
      (p) =>
        !listed.has(p.id) &&
        (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)),
    );

    return ok({ products: available.slice(0, 50) });
  },
);
