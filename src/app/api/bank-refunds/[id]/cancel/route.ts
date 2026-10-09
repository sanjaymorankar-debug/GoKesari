/** The customer cancels their refund to bank before finance sends it; the amount returns to the wallet. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { cancelBankRefund } from "@/server/services/bank-refunds";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`bank-refund:${user.id}`, RATE_LIMITS.PAYMENT);
  const { id } = await context.params;
  return ok(await cancelBankRefund(id, user));
});
