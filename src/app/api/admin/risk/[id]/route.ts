/** Close a risk flag: DISMISSED (false positive) or ACTIONED, with a note (GS-068). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reviewRiskFlag } from "@/server/services/risk";

const schema = z.object({ decision: z.enum(["DISMISSED", "ACTIONED"]), note: z.string().min(5).max(500) });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.RISK_REVIEW);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await reviewRiskFlag(id, body.decision, body.note, actor));
});
