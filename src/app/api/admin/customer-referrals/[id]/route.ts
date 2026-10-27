/**
 * D-25: reverse a rewarded customer referral found fraudulent. WALLET_ADJUST
 * (it debits wallets).
 *   { action: "reverse", reason }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reverseCustomerReferral } from "@/server/services/customer-referrals";

const schema = z.object({ action: z.literal("reverse"), reason: z.string().trim().min(5).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.WALLET_ADJUST);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await reverseCustomerReferral(id, body.reason, actor));
});
