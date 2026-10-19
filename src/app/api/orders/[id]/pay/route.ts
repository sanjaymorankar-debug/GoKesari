/**
 * "Retry payment" for an online order whose payment failed or expired
 * (batch-2026-10 WS-A). Reuses the same order(s): the stock is taken again
 * and a new payment attempt is opened — or the open one is returned, so a
 * double click never starts two payments.
 *   POST → { intentId, status, amountPaise, redirectUrl, alreadyPaid }
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { retryOrderPayment } from "@/server/payments/order-payments";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  enforceRateLimit(`payment:${user.id}`, RATE_LIMITS.PAYMENT);
  const { id } = await context.params;
  return ok(await retryOrderPayment(user.id, id));
});
