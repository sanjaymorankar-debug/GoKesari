/** F2: approve (apply, encrypted) or reject (with reason) a rider's identity / bank change. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideChangeRequest } from "@/server/services/rider-profile";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  enforceRateLimit(`rider-change-review:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await decideChangeRequest(id, await parseBody(request, schema), user));
});
