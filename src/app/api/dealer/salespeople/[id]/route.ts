/**
 * PATCH { status: "ACTIVE" | "INACTIVE" } — the dealer deactivates or reactivates one of their
 * own employees (another dealer's employee is "not found"). docs/dealer-programme, GKS-DR-004.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser, setSalespersonStatus } from "@/server/dealers/service";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }));
  return ok({ salesperson: await setSalespersonStatus(dealer.id, id, body.status, user) });
});
