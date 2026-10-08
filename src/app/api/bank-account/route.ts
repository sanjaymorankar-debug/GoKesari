/**
 * The signed-in customer's bank account for refunds (docs/four-features-2026-10, feature 3).
 *   GET  → the current account (masked) and how verification works on this site
 *   PUT  { method: BANK_ACCOUNT | UPI, accountHolderName, accountNumber?, confirmAccountNumber?, ifsc?, upiId? }
 */
import type { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getBankAccountView, saveBankAccount, verificationGatewayMode } from "@/server/services/bank-accounts";
import { bankAccountSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ account: await getBankAccountView(user.id, null), gateway: verificationGatewayMode() });
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`bank-account:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, bankAccountSchema);
  return ok(await saveBankAccount({ userId: user.id, shopId: null }, body, user));
});
