/** Edit a festival collection (dates, titles, on/off, home banner): PATCH with the full form. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveFestivalCollection } from "@/server/puja/admin";
import { festivalSchema } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ festivalId: string }>) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  const { festivalId } = await context.params;
  return ok(await saveFestivalCollection(festivalId, await parseBody(request, festivalSchema), user));
});
