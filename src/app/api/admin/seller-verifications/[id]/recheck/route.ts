/** Ask the KYC vendor again for one seller document, with the number on file. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { recheckVerification } from "@/server/services/seller-verification";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  enforceRateLimit(`seller-verification-review:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await recheckVerification(id, user));
});
