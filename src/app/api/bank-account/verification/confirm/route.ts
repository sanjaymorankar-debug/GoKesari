/**
 * After the Cashfree checkout closes: the server asks Cashfree what happened
 * to the ₹1 (never trusting the browser) and records verified / failed.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { confirmBankVerification } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

const schema = z.object({ gatewayOrderId: z.string().min(8).max(80) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-verify:${user.id}`, RATE_LIMITS.PAYMENT);
  const { gatewayOrderId } = await parseBody(request, schema);
  return ok(await confirmBankVerification(gatewayOrderId, user));
});
