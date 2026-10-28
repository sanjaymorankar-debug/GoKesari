/** PATCH { status: "CLOSED" } — the dealer closes one of their own open leads. docs/dealer-programme. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireDealerProgramme } from "@/server/dealers/http";
import { closeLead } from "@/server/dealers/leads";
import { requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  await parseBody(request, z.object({ status: z.literal("CLOSED") }));
  return ok({ lead: await closeLead(dealer.id, z.string().uuid().parse((await context.params).id), user) });
});
