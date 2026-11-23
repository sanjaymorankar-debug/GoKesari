/** RBAC v2 Phase 3: the CA closes (action CLOSE) or reopens (action REOPEN, reason required) a month. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { closePeriod, reopenPeriod } from "@/server/rbac-accounting/journals";

const schema = z.object({ action: z.enum(["CLOSE", "REOPEN"]), reason: z.string().trim().max(500).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ code: string }>) => {
  const actor = await requirePermission(PERMISSIONS.FIN_PERIOD_CLOSE);
  const { code } = await context.params;
  const body = await parseBody(request, schema);
  return ok(body.action === "CLOSE" ? await closePeriod(code, actor, body.reason) : await reopenPeriod(code, actor, body.reason ?? ""));
});
