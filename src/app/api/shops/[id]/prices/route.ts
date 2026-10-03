/**
 * The shop owner's own prices, several at once (the inventory page's "Save").
 *   PATCH { prices: [{ shopProductId, pricePaise }] }
 *
 * Only the shop's owner may use it, and only for listings of this shop. Staff
 * price changes go through the price-request flow (PATCH /api/shop-products/[id]).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { setShopPrices } from "@/server/services/catalogue";

export const dynamic = "force-dynamic";

const schema = z.object({
  prices: z
    .array(
      z.object({
        shopProductId: z.string().uuid(),
        pricePaise: z.number().int().positive("Price must be a number greater than 0."),
      }),
    )
    .max(1000),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const { user, isPrivileged } = await requireShopAccess(id, {
    anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
  });
  if (isPrivileged) throw forbidden("Only the shop owner can set this shop's prices here.");
  const { prices } = await parseBody(request, schema);
  return ok(await setShopPrices(id, prices, user as never));
});
