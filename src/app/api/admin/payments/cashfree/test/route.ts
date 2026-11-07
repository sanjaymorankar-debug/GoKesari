/**
 * Finance: start a ₹1 Cashfree payment test (docs/payments-cashfree-audit-2026-11).
 * POST → { orderId, paymentSessionId, mode } — the admin pays it in Cashfree's own
 * checkout with any method; POST …/test/<orderId> then reads the result and refunds
 * the ₹1. The amount is fixed on the server. FINANCE_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { startCashfreeLiveTest } from "@/server/payments/cashfree-health";

export const dynamic = "force-dynamic";

/** ₹1 (default), or ₹2 for the partial-refund test. */
const schema = z.object({ amountPaise: z.union([z.literal(100), z.literal(200)]).optional() }).default({});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  enforceRateLimit(`cashfree-test:${user.id}`, RATE_LIMITS.PAYMENT);
  // The body is optional: none means the defaults.
  const body = (await request.clone().text()).trim() ? await parseBody(request, schema) : {};
  return ok(await startCashfreeLiveTest(user, body));
});
