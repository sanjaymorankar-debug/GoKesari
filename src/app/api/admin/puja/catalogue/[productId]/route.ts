/**
 * Edit one master product (brief §6): names (en/hi/mr), synonyms, MRP, HSN, GST and the
 * "to verify with CA" flag, loose / perishable / edible, festivals, product type, retire
 * (active=false) or bring back. PATCH with any subset.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { PUJA_FESTIVALS } from "@/lib/puja";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { updateMasterProduct } from "@/server/puja/admin";
import { paise, requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  nameHi: z.string().trim().max(100).nullish(),
  nameMr: z.string().trim().max(100).nullish(),
  synonyms: z.array(z.string().trim().max(40)).max(40).optional(),
  mrpPaise: paise.nullish(),
  hsnCode: z.string().trim().max(8).nullish(),
  gstRateBp: z.number().int().min(0).max(4000).nullish(),
  taxToVerify: z.boolean().optional(),
  loose: z.boolean().optional(),
  perishable: z.boolean().optional(),
  edible: z.boolean().optional(),
  festivals: z.array(z.enum(PUJA_FESTIVALS.map((f) => f.key) as [string, ...string[]])).optional(),
  active: z.boolean().optional(),
  typeId: z.string().uuid().nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ productId: string }>) => {
  const user = await requirePujaStaff();
  const { productId } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateMasterProduct(productId, body, user));
});
