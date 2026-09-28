/**
 * Operations confirms a delivery the customer could not confirm by OTP
 * (GS-043 fallback). DELIVERY_ORDER_MANAGE_ANY (operator/admin) only; a proof
 * note is required and the action is audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { confirmDeliveryByOperator } from "@/server/services/delivery-assignment";

const schema = z.object({ proofNote: z.string().min(5).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await confirmDeliveryByOperator(id, user, body.proofNote));
});
