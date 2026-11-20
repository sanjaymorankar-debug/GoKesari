/**
 * Puja Samagri shop-type configuration (brief §6): GET → on/off, FSSAI toggle for edible
 * lines, seed stock, counts; PATCH { enabled?, edibleNeedsFssai?, seedDefaultStock? }.
 * The registration fee is the standard shop fee (Admin → Registration fees).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { getPujaConfig, setPujaConfig } from "@/server/puja/admin";
import { requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePujaStaff();
  return ok(await getPujaConfig());
});

const schema = z.object({
  enabled: z.boolean().optional(),
  edibleNeedsFssai: z.boolean().optional(),
  seedDefaultStock: z.number().int().min(0).max(100000).optional(),
});

export const PATCH = route(async (request: NextRequest) => {
  const user = await requirePujaStaff();
  return ok(await setPujaConfig(await parseBody(request, schema), user));
});
