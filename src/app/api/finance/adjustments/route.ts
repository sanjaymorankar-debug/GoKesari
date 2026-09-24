/**
 * Financial adjustments (Part G), FINANCE_MANAGE (admin):
 *   SHOP_ADJUSTMENT (shopId) · RIDER_ADJUSTMENT / DELIVERY_ADJUSTMENT
 *   (deliveryPartnerId) · MARKETPLACE_ADJUSTMENT (platform only).
 * amountPaise: + owed to the shop/rider, − recovered. Optional orderNumber
 * links it to an order. Flows into the next settlement / payout.
 * GET lists recent adjustments (FINANCE_VIEW).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listAdjustments, recordAdjustment } from "@/server/services/finance";

const schema = z.object({
  type: z.enum(["SHOP_ADJUSTMENT", "RIDER_ADJUSTMENT", "DELIVERY_ADJUSTMENT", "MARKETPLACE_ADJUSTMENT"]),
  shopId: z.string().uuid().nullish(),
  deliveryPartnerId: z.string().uuid().nullish(),
  orderNumber: z.string().max(40).nullish(),
  amountPaise: z.number().int().refine((v) => v !== 0, "Amount cannot be zero"),
  reason: z.string().min(3).max(300),
  requestId: z.string().min(8).max(64),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listAdjustments({ limit: 200 }));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await recordAdjustment(body, user), 201);
});
