/**
 * Creates a payment intent for a wallet top-up (requirement §20).
 *
 * This endpoint moves NO money. It only creates a gateway order; the wallet is
 * credited exclusively by /api/wallet/verify after signature verification.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createTopUpOrder } from "@/server/services/payments";

const schema = z.object({
  // Paise, so the client cannot smuggle a fractional rupee amount.
  amountPaise: z.number().int().positive(),
  voucherCode: z.string().max(32).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.WALLET_TOPUP_OWN);
  enforceRateLimit(`payment:${user.id}`, RATE_LIMITS.PAYMENT);

  const { amountPaise, voucherCode } = await parseBody(request, schema);
  const result = await createTopUpOrder(user.id, amountPaise, voucherCode);

  return ok({
    paymentId: result.payment.id,
    gatewayOrderId: result.gatewayOrderId,
    paymentSessionId: result.paymentSessionId,
    cashfreeMode: result.cashfreeMode,
    amountPaise: result.amountPaise,
    currency: result.currency,
    mock: result.mock,
    // PAY-2: a top-up through a payment intent with no Cashfree SDK session — send the browser here.
    redirectUrl: result.redirectUrl,
    voucherPreview: result.voucherPreview,
  });
});
