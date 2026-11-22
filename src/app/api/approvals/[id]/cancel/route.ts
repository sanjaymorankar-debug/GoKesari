/** RBAC v2: the requester withdraws a pending request (docs/rbac). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelApproval } from "@/server/approvals";

const schema = z.object({ comment: z.string().trim().max(1000).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await cancelApproval(id, actor, body.comment ?? null));
});
