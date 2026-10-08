/** Decide one seller document: { decision: "approve" | "reject" | "more_info", reason }. A reason is required to reject or to ask for more information. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adminDecideVerification } from "@/server/services/seller-verification";

const schema = z.object({
  decision: z.enum(["approve", "reject", "more_info"]),
  reason: z.string().trim().max(500).default(""),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  enforceRateLimit(`seller-verification-review:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await adminDecideVerification(id, body, user));
});
