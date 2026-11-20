/**
 * Product types (brief §5f). GET → the puja types this shop can use (approved + its own).
 * POST { categoryId, name, nameHi?, nameMr?, unit, variantAttributes?, loose?, perishable?,
 * edible?, confirmDuplicate? } → creates the shop's own type, usable at once and sent for
 * review. The duplicate check runs first: 409 with details.matches (closest first).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { PUJA_UNITS } from "@/lib/puja";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createProductType, listPujaTypes } from "@/server/puja/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  return ok({ types: await listPujaTypes(id) });
});

const schema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(2, "Give the product type a name.").max(60),
  nameHi: z.string().trim().max(60).nullish(),
  nameMr: z.string().trim().max(60).nullish(),
  unit: z.enum(PUJA_UNITS as unknown as [string, ...string[]]),
  variantAttributes: z.array(z.string().trim().max(30)).max(8).optional(),
  loose: z.boolean().optional(),
  perishable: z.boolean().optional(),
  edible: z.boolean().optional(),
  confirmDuplicate: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, schema);
  return ok(await createProductType(id, body, user as never), 201);
});
