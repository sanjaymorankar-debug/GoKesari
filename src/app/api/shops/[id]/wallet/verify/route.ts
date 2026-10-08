/**
 * Confirms a shop wallet recharge with Cashfree and credits the shop wallet.
 * Nothing the client posts is proof of payment — only which order to check —
 * and the credit is idempotent on the gateway payment id (the webhook may
 * have credited it already).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { verifyShopWalletTopUp } from "@/server/services/payments";

const schema = z.object({ gatewayOrderId: z.string().min(1) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.WALLET_ADJUST });
  enforceRateLimit(`payment-verify:${user.id}`, RATE_LIMITS.PAYMENT);

  const body = await parseBody(request, schema);
  const result = await verifyShopWalletTopUp({ userId: user.id, shopId: id, gatewayOrderId: body.gatewayOrderId });
  return ok({ success: true, balancePaise: result.balancePaise, alreadyProcessed: result.alreadyProcessed });
});
