/**
 * The customer's view of one online payment (batch-2026-10 WS-A) — polled by
 * /orders/payment-return. Only the payer can read it. While the payment is
 * still open, reading it also re-asks the gateway (at most every 10 s).
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getPaymentStatusForCustomer } from "@/server/payments/order-payments";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`payment-status:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  return ok(await getPaymentStatusForCustomer(user.id, id));
});
