/** My live queue position for a token / walk-in clinic today. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { queuePosition } from "@/server/health/booking";
import { uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await queuePosition(await uuidParam(context, "id"), user));
});
