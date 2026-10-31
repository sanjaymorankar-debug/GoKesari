/** Gig worker flow (feature 3): an admin starts the review of, approves or rejects (with a reason) one document. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { decideBackgroundDoc } from "@/server/services/rider-background-docs";

const schema = z.object({
  status: z.enum(["UNDER_REVIEW", "APPROVED", "REJECTED"]),
  reason: z.string().max(500).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok({ document: await decideBackgroundDoc(id, body.status, body.reason ?? null, user) });
});
