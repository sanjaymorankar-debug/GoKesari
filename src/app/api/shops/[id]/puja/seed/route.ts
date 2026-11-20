/**
 * Take the puja catalogue (brief rule 3 and §5a/§5b): POST
 *   { excludeCategoryIds?: uuid[], excludeProductIds?: uuid[] }  every product of the other
 *     categories goes into the shop at the seed stock (100), priced at MRP; loose / no-MRP
 *     items with an empty price for the owner to set;
 *   { onlyProductIds: uuid[] }  the products ticked in the catalogue browser.
 * Safe to repeat: products already listed are skipped.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { seedPujaCatalogue } from "@/server/puja/service";
import { notifyFirstProducts } from "@/server/services/shop-onboarding-events";

export const dynamic = "force-dynamic";

const schema = z.object({
  excludeCategoryIds: z.array(z.string().uuid()).max(100).optional(),
  excludeProductIds: z.array(z.string().uuid()).max(1000).optional(),
  onlyProductIds: z.array(z.string().uuid()).min(1).max(600).optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, schema);
  const result = await seedPujaCatalogue(id, body, user as never);
  if (result.firstProducts) await notifyFirstProducts(id, result.added);
  return ok(result);
});
