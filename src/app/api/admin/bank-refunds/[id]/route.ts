/**
 * Finance decides a refund to bank. FINANCE_MANAGE.
 *   { action: "process" }                    sent from the bank (optional step)
 *   { action: "pay", reference }             paid — the bank's reference (UTR)
 *   { action: "fail", reason }               the transfer failed — the amount returns to the wallet
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideBankRefund } from "@/server/services/bank-refunds";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("process") }),
  z.object({ action: z.literal("pay"), reference: z.string().trim().min(4, "Enter the bank's reference (UTR).").max(60) }),
  z.object({ action: z.literal("fail"), reason: z.string().trim().min(3, "Say why the transfer failed.").max(500) }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  enforceRateLimit(`bank-refund-decide:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  return ok(await decideBankRefund(id, await parseBody(request, schema), user));
});
