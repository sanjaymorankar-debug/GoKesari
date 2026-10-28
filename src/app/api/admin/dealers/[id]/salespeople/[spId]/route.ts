/**
 * PATCH { status: "ACTIVE" | "INACTIVE" } — ADMIN only: deactivate or reactivate a dealer's
 * employee (oversight). docs/dealer-programme, GKS-DR-004.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { setSalespersonStatus } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; spId: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const params = await context.params;
  const body = await parseBody(request, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }));
  return ok({ salesperson: await setSalespersonStatus(z.string().uuid().parse(params.id), z.string().uuid().parse(params.spId), body.status, admin) });
});
