/**
 * docs/flows-v3/wave2.md (flag flow_f13): any shop creates its own product type in a category (puja shops already
 * could). POST { categoryId, name, nameHi?, nameMr?, unit, loose?, perishable?, edible?, confirmDuplicate? } →
 * usable in the shop at once and sent to our team for review (createProductType, the same duplicate check: 409 with
 * details.matches). 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { PRODUCT_UNITS } from "@/lib/product-units";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { flowOn } from "@/server/flows/wave2-rules";
import { createProductType } from "@/server/puja/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(2, "Give the product type a name.").max(60),
  nameHi: z.string().trim().max(60).nullish(),
  nameMr: z.string().trim().max(60).nullish(),
  unit: z.enum(PRODUCT_UNITS),
  loose: z.boolean().optional(),
  perishable: z.boolean().optional(),
  edible: z.boolean().optional(),
  confirmDuplicate: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  if (!(await flowOn("flow_f13"))) throw notFound("Page");
  const body = await parseBody(request, schema);
  return ok(await createProductType(id, body, user as never), 201);
});
