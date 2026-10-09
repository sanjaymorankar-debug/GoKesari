/** PATCH → change a distributor (commission override, status) (Module 3). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { distributorSchema, saveDistributor } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const id = z.string().uuid().parse((await context.params).id);
  return ok({ distributor: await saveDistributor(id, await parseBody(request, distributorSchema), user) });
});
