/**
 * A new shop's starter shelf (onboarding Phase B, services/starter-shelf.ts).
 *   GET                          the products offered, already ticked in the screen (its owner, or staff)
 *   POST { items: [{ productId, pricePaise, stock }] }   lists them in one go
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { notifyFirstProducts } from "@/server/services/shop-onboarding-events";
import { getStarterShelf, publishStarterShelf } from "@/server/services/starter-shelf";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  return ok(await getStarterShelf(id));
});

const schema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        pricePaise: z.number().int().min(1, "Every ticked product needs a price.").max(100_000_000),
        stock: z.number().min(0).max(1_000_000),
      }),
    )
    .min(1, "Tick at least one product.")
    .max(200),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  const { items } = await parseBody(request, schema);
  // Same actor shape as adding one product (../products/route.ts).
  const result = await publishStarterShelf(id, items, user as never);
  if (result.firstProducts) await notifyFirstProducts(id, result.added);
  return ok(result);
});
