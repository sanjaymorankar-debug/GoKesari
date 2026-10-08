/**
 * Starts a shop wallet recharge (rule shopWallet). Moves NO money: it creates
 * the gateway order; the wallet is credited only by ../verify (or the Cashfree
 * webhook) once Cashfree itself confirms the payment. Only the shop's owner —
 * staff correct a balance with ../adjust instead.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createShopWalletTopUpOrder } from "@/server/services/payments";

const schema = z.object({
  // Paise, so the client cannot smuggle a fractional rupee amount.
  amountPaise: z.number().int().positive(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user, isPrivileged } = await requireShopAccess(id, { anyPermission: PERMISSIONS.WALLET_ADJUST });
  if (isPrivileged) throw forbidden("Only the shop's owner can recharge its wallet. Record an adjustment instead.");
  enforceRateLimit(`payment:${user.id}`, RATE_LIMITS.PAYMENT);

  const { amountPaise } = await parseBody(request, schema);
  const result = await createShopWalletTopUpOrder(id, user.id, amountPaise);
  return ok({
    paymentId: result.payment.id,
    gatewayOrderId: result.gatewayOrderId,
    paymentSessionId: result.paymentSessionId,
    cashfreeMode: result.cashfreeMode,
    amountPaise: result.amountPaise,
    currency: result.currency,
    mock: result.mock,
  });
});
