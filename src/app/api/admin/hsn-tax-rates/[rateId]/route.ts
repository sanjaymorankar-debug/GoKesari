/** PATCH { effectiveTo } → ends a fallback HSN rate on a date. Admin only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { endHsnRate } from "@/server/gst/config";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ rateId: string }>) => {
  const user = await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  const rateId = z.string().uuid().parse((await context.params).rateId);
  const { effectiveTo } = await parseBody(request, z.object({ effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
  await endHsnRate(rateId, effectiveTo, user);
  return noContent();
});
