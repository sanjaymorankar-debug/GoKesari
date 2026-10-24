/** Decide an MRP correction: PATCH { decision: "ACCEPT" | "REJECT", note, mrpPaise? } (operations). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_MRP_PAISE, MIN_PRICE_PAISE } from "@/lib/price-rules";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideCorrection } from "@/server/services/mrp-governance";

const schema = z.object({
  decision: z.enum(["ACCEPT", "REJECT"]),
  note: z.string().min(3).max(500),
  mrpPaise: z.number().int().min(MIN_PRICE_PAISE, "MRP must be more than ₹0.").max(MAX_MRP_PAISE, "MRP can be at most ₹10,00,000.").optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MRP_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideCorrection(id, body.decision, body.note, user, body.mrpPaise));
});
