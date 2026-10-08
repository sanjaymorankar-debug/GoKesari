/**
 * Starts the ₹1 verification of the caller's own bank account (customer or shop):
 * { accountId } → the gateway order (Cashfree checkout session, or the test simulator).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startBankVerification } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

const schema = z.object({ accountId: z.string().uuid() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-verify:${user.id}`, RATE_LIMITS.PAYMENT);
  const { accountId } = await parseBody(request, schema);
  return ok(await startBankVerification(accountId, user), 201);
});
