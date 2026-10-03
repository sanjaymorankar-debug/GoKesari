/**
 * "Add Existing Product" search — every APPROVED product in the categories the
 * shop carries, already-listed products excluded. A PENDING_APPROVAL product
 * created by another shop stays invisible here, which is the entire point of
 * the approval gate.
 *   GET ?q=&categoryId=
 */
import type { NextRequest } from "next/server";

import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { listProductsVisibleToShop } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });
    enforceRateLimit(`catalogue-search:${user.id}`, RATE_LIMITS.MUTATION);

    const p = new URL(request.url).searchParams;
    const categoryId = p.get("categoryId");
    const { products } = await listProductsVisibleToShop(id, {
      query: p.get("q") ?? undefined,
      categoryId: categoryId && UUID.test(categoryId) ? categoryId : undefined,
      excludeListed: true,
      limit: 50,
    });
    // The picker reads `category.name`, as it did before category visibility.
    return ok({
      products: products.map((r) => ({ ...r, category: { id: r.categoryId, name: r.categoryName } })),
    });
  },
);
