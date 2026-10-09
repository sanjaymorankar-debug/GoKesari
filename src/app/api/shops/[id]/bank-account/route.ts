/**
 * A shop's payout bank account (docs/four-features-2026-10, feature 3).
 *   GET  → the owner, or finance (FINANCE_VIEW)
 *   PUT  → the owner only: { method, accountHolderName, accountNumber?, confirmAccountNumber?, ifsc?, upiId? }
 */
import type { NextRequest } from "next/server";

import { bankAccountSchema } from "@/app/api/bank-account/schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getBankAccountView, saveBankAccount, verificationGatewayMode } from "@/server/services/bank-accounts";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.FINANCE_VIEW });
  return ok({ account: await getBankAccountView(user.id, id), gateway: verificationGatewayMode() });
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.FINANCE_VIEW });
  enforceRateLimit(`bank-account:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, bankAccountSchema);
  return ok(await saveBankAccount({ userId: user.id, shopId: id }, body, user));
});
