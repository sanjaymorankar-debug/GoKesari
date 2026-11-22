/**
 * RBAC v2: approve or reject a request (docs/rbac). Who may decide is checked by the engine:
 * never the requester; ADMIN-checked requests need an admin, CA-checked a CA, shop changes the
 * shop's owner. A rejection needs a comment.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { decideApproval } from "@/server/approvals";

const schema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().trim().max(1000).nullish(),
  items: z
    .array(z.object({ itemId: z.string().uuid(), decision: z.enum(["APPROVE", "REJECT"]), comment: z.string().trim().max(1000).nullish() }))
    .max(2000)
    .optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideApproval({ requestId: id, actor, decision: body.decision, comment: body.comment ?? null, items: body.items }));
});
