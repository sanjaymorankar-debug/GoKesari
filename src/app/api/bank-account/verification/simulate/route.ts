/**
 * Test gateway for the ₹1 verification — only where no gateway keys are set
 * and never on gokesari.com (404 otherwise). The tester picks the method and
 * the outcome; everything after the payment runs as for a real one.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { VERIFICATION_METHODS } from "@/lib/bank-accounts";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { simulateBankVerification } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

const schema = z.object({
  gatewayOrderId: z.string().min(8).max(80),
  method: z.enum(VERIFICATION_METHODS),
  outcome: z.enum(["SUCCESS", "FAILED", "NAME_MISMATCH"]),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-verify:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, schema);
  return ok(await simulateBankVerification(body.gatewayOrderId, body, user));
});
