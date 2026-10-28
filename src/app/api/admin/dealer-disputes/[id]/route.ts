/**
 * POST { decision: "UPHELD" | "REJECTED", note } — staff (admin or operator) decide an attribution
 * claim; upholding moves the shop to the claiming dealer (audited). docs/dealer-programme.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { decideDispute } from "@/server/dealers/disputes";
import { requireDealerProgramme } from "@/server/dealers/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const staff = await requireRole("ADMIN", "OPERATOR");
  const body = await parseBody(request, z.object({ decision: z.enum(["UPHELD", "REJECTED"]), note: z.string().max(1000) }));
  await decideDispute(z.string().uuid().parse((await context.params).id), body.decision, body.note, staff);
  return ok({ decided: true });
});
