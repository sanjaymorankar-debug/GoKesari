/** docs/identity-verification-2026-11: an admin approves or rejects an identity check waiting for review, with a note (audited). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { decideIdentityReview } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

const schema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().min(3).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok({ verification: await decideIdentityReview(id, body.decision, body.note, user) });
});
