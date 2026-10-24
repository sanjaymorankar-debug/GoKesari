/**
 * MRP corrections.
 *   POST { productId, shopId?, claimedMrpPaise, note? }  a shop owner disputes the MRP; the master value is untouched
 *   GET ?status=PENDING|ACCEPTED|REJECTED                operations' queue
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_MRP_PAISE, MIN_PRICE_PAISE } from "@/lib/price-rules";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listCorrections, raiseCorrection } from "@/server/services/mrp-governance";

export const dynamic = "force-dynamic";

const schema = z.object({
  productId: z.string().uuid(),
  shopId: z.string().uuid().nullish(),
  // The printed MRP: at least 1 paisa, at most ₹10 lakh (TC-CAT-062).
  claimedMrpPaise: z.number().int().min(MIN_PRICE_PAISE, "MRP must be more than ₹0.").max(MAX_MRP_PAISE, "MRP can be at most ₹10,00,000."),
  note: z.string().max(500).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MRP_DISPUTE);
  const body = await parseBody(request, schema);
  return ok(await raiseCorrection(body, user), 201);
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PRODUCT_MRP_MANAGE);
  const status = (["PENDING", "ACCEPTED", "REJECTED"] as const).find((s) => s === new URL(request.url).searchParams.get("status")) ?? "PENDING";
  return ok({ corrections: await listCorrections(status) });
});
