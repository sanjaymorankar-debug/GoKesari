/** Who viewed, printed, downloaded or shared what in this person's record (stored UTC, shown IST). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { accessLogFor } from "@/server/health/consent";
import { uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok({ log: await accessLogFor(await uuidParam(context, "id"), user) });
});
