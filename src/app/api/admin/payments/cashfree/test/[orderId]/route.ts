/**
 * Finance: finish a ₹1 Cashfree payment test — Cashfree's own record of the order
 * and its attempts (method, cf_payment_id, time), and the ₹1 refunded at once
 * (once; asking again shows the same refund). FINANCE_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { finishCashfreeLiveTest } from "@/server/payments/cashfree-health";

export const dynamic = "force-dynamic";

/** refund: "full" (default) — all that is left; "partial" — ₹1 of a ₹2 test. */
const schema = z.object({ refund: z.enum(["full", "partial"]).optional() }).default({});

export const POST = route(async (request: NextRequest, context: RouteContext<{ orderId: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  enforceRateLimit(`cashfree-test:${user.id}`, RATE_LIMITS.PAYMENT);
  const { orderId } = await context.params;
  // The body is optional: none means the defaults.
  const body = (await request.clone().text()).trim() ? await parseBody(request, schema) : {};
  return ok(await finishCashfreeLiveTest(orderId, user, body));
});
