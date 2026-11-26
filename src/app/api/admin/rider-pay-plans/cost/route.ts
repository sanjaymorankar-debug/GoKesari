/** Delivery economics of recent delivered orders (admin only; never part of a rider response). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { orderCostView } from "@/server/services/rider-pay-plans";

export const dynamic = "force-dynamic";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { limit } = parseQuery(request, querySchema);
  return ok({ orders: await orderCostView(limit ?? 50) });
});
