/**
 * Check a saved bank account with the bank again (docs/four-features-2026-10, O-7;
 * rule bankAccountCheck). The holder only — a customer's refund account or a
 * shop owner's payout account. { accountId } → the account, with the bank's answer.
 * Limited to bankAccountCheck.maxChecksPerDay (each check costs a fee).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { runBankAccountCheck } from "@/server/services/bank-account-check";
import { getBankAccountViewById } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

const schema = z.object({ accountId: z.string().uuid() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-account-check:${user.id}`, RATE_LIMITS.PAYMENT);
  const { accountId } = await parseBody(request, schema);
  await runBankAccountCheck(accountId, user, "RETRY");
  return ok(await getBankAccountViewById(accountId));
});
