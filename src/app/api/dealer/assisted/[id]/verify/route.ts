/** Dealer-assisted registration, step 2: POST { code } — the code the owner received. docs/dealer-programme. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { verifyAssistedOwner } from "@/server/dealers/assisted";
import { requireDealerProgramme } from "@/server/dealers/http";
import { requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  const body = await parseBody(request, z.object({ code: z.string().max(10) }));
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok({ session: await verifyAssistedOwner(dealer, z.string().uuid().parse((await context.params).id), body.code, user, ip) });
});
