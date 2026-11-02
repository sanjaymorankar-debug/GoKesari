/** Billing v2 (docs/billing §5.2): cancel GoKesari's s.9(5) delivery-fee invoice — marks it, never deletes. Admin only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { requireFeature } from "@/server/services/feature-flags";
import { cancelDeliveryFeeInvoice } from "@/server/tax/delivery-invoice";

const body = z.object({ reason: z.string().trim().min(5).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  await requireFeature("billing_v2");
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Delivery invoice");
  const { reason } = await parseBody(request, body);
  return ok(await cancelDeliveryFeeInvoice(id, reason, user));
});
