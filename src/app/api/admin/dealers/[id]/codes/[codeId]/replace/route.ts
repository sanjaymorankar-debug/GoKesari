/**
 * POST { reason } — ADMIN only: replace a dealer's (or an employee's) code. The old code is
 * refused for new registrations; shops already registered with it stay attributed.
 * docs/dealer-programme, GKS-DR-003.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { replaceDealerCode } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; codeId: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const params = await context.params;
  const body = await parseBody(request, z.object({ reason: z.string().max(300) }));
  return ok(await replaceDealerCode(z.string().uuid().parse(params.id), z.string().uuid().parse(params.codeId), body.reason, admin));
});
