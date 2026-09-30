/** Approve or reject a submitted campaign (WF-009). MARKETING_APPROVE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideCampaign } from "@/server/services/marketing";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.MARKETING_APPROVE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideCampaign(id, body.decision, body.reason ?? null, actor));
});
