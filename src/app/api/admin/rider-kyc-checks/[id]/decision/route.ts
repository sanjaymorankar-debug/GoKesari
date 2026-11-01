/** Gig worker flow (feature 2): an admin marks a partner's PAN or Aadhaar check Verified or Failed by hand. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { decideRiderKycCheck } from "@/server/services/rider-kyc";

const schema = z.object({ decision: z.enum(["VERIFIED", "FAILED"]), note: z.string().min(3).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok({ check: await decideRiderKycCheck(id, body.decision, body.note, user) });
});
