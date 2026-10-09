/**
 * Refunds to the signed-in customer's bank (docs/four-features-2026-10, rule bankRefunds).
 *   GET  → refunds that can be sent to the bank, the account they would go to, and past requests
 *   POST { refundTransactionId } → send that refund to the bank (it leaves the wallet now)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { conflict } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getCustomerBankRefunds, requestBankRefund } from "@/server/services/bank-refunds";

export const dynamic = "force-dynamic";

const schema = z.object({ refundTransactionId: z.string().uuid() });

export const GET = route(async () => {
  const user = await requireUser();
  const refunds = await getCustomerBankRefunds(user.id);
  if (!refunds) throw conflict("Refunds to a bank account are not available.");
  return ok(refunds);
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-refund:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, schema);
  return ok(await requestBankRefund(user.id, body.refundTransactionId, user), 201);
});
