/**
 * Refund a delivered (or disputed) order to the customer's wallet, full or
 * partial (GS-057 basic refunds, RBAC-011). ORDER_REFUND — operator/admin.
 * `chargeTo: "SHOP"` deducts the shop's share from its next settlement.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { refundDeliveredOrder } from "@/server/services/finance";

const schema = z.object({
  orderNumber: z.string().min(3).max(40),
  amountPaise: z.number().int().positive(),
  reason: z.string().min(3).max(300),
  chargeTo: z.enum(["SHOP", "PLATFORM"]),
  requestId: z.string().min(8).max(64),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_REFUND);
  const body = await parseBody(request, schema);
  return ok(await refundDeliveredOrder(body, user), 201);
});
