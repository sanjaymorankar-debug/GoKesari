/**
 * Puja master catalogue for operators and admins (brief §6). GET ?filters (includeRetired=1,
 * taxToVerify=1 …) → items + total; POST → adds a product to the master (approved), Hindi and
 * Marathi names required, duplicate name in the category refused (409).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { PUJA_FESTIVALS, PUJA_UNITS } from "@/lib/puja";
import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { createMasterProduct, listMasterCatalogue } from "@/server/puja/admin";
import { catalogueQuerySchema, paise, requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePujaStaff();
  return ok(await listMasterCatalogue(parseQuery(request, catalogueQuerySchema)));
});

const schema = z.object({
  categoryId: z.string().uuid(),
  typeId: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(100),
  nameHi: z.string().trim().min(1, "Hindi name is required.").max(100),
  nameMr: z.string().trim().min(1, "Marathi name is required.").max(100),
  synonyms: z.array(z.string().trim().max(40)).max(30).optional(),
  variant: z.string().trim().max(40).nullish(),
  unit: z.enum(PUJA_UNITS as unknown as [string, ...string[]]),
  mrpPaise: paise.nullish(),
  hsnCode: z.string().trim().max(8).nullish(),
  gstRateBp: z.number().int().min(0).max(4000).nullish(),
  loose: z.boolean().optional(),
  perishable: z.boolean().optional(),
  edible: z.boolean().optional(),
  festivals: z.array(z.enum(PUJA_FESTIVALS.map((f) => f.key) as [string, ...string[]])).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePujaStaff();
  return ok(await createMasterProduct(await parseBody(request, schema), user), 201);
});
