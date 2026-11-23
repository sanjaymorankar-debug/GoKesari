/** RBAC v2 documents: a Support Manager or admin marks a document verified or rejected. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { verifyStaffDocument } from "@/server/rbac-support/documents";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const { status } = await parseBody(request, z.object({ status: z.enum(["VERIFIED", "REJECTED"]) }));
  return ok(await verifyStaffDocument(id, status, actor));
});
