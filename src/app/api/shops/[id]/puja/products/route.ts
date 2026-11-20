/**
 * The shop's own product (brief §5g): POST { categoryId, typeId?, name, nameHi?, nameMr?,
 * synonyms?, unit, loose?, perishable?, edible?, description?, hsnCode?, gstRateBp?,
 * festivals?, variants: [{ label?, mrpPaise?, pricePaise?, stock }], confirmDuplicate? }.
 * One master product per variant, listed in the shop at once; sent for review (§5h).
 * The duplicate check runs first: 409 with details.matches (closest first).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { PUJA_FESTIVALS, PUJA_UNITS } from "@/lib/puja";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { paise } from "@/server/puja/route-helpers";
import { createOwnProducts } from "@/server/puja/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  categoryId: z.string().uuid(),
  typeId: z.string().uuid().nullish(),
  name: z.string().trim().min(2, "Give the product a name.").max(100),
  nameHi: z.string().trim().max(100).nullish(),
  nameMr: z.string().trim().max(100).nullish(),
  synonyms: z.array(z.string().trim().max(40)).max(30).optional(),
  unit: z.enum(PUJA_UNITS as unknown as [string, ...string[]]),
  loose: z.boolean().optional(),
  perishable: z.boolean().optional(),
  edible: z.boolean().optional(),
  description: z.string().trim().max(1000).nullish(),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "HSN is 4 to 8 digits.").nullish().or(z.literal("")),
  gstRateBp: z.number().int().min(0).max(4000).nullish(),
  festivals: z.array(z.enum(PUJA_FESTIVALS.map((f) => f.key) as [string, ...string[]])).max(14).optional(),
  variants: z
    .array(z.object({ label: z.string().trim().max(40).nullish(), mrpPaise: paise.nullish(), pricePaise: paise.nullish(), stock: z.number().min(0).max(1_000_000) }))
    .min(1, "Add at least one variant.")
    .max(12),
  confirmDuplicate: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, schema);
  return ok(await createOwnProducts(id, { ...body, hsnCode: body.hsnCode || null }, user as never), 201);
});
