/** RBAC v2 Phase 7: whoever raised a staff ticket (or a Support Manager) confirms a resolved ticket → Closed. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { confirmResolution } from "@/server/rbac-support/desk";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const { note } = await parseBody(request, z.object({ note: z.string().trim().max(500).nullish() }));
  return ok(await confirmResolution(id, actor, note));
});
