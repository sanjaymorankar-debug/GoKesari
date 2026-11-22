/** RBAC v2 documents: an admin asks for deletion; a second admin approves it in Admin → Approvals. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requestDocumentDeletion } from "@/server/rbac-support/documents";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireRole("ADMIN");
  const { id } = await context.params;
  const { reason } = await parseBody(request, z.object({ reason: z.string().trim().min(5).max(500) }));
  return ok(await requestDocumentDeletion(id, reason, actor), 202);
});
