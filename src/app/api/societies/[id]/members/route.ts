/** Ask to join a verified society as a resident (society staff approve). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requestMembership } from "@/server/services/societies";

const schema = z.object({ unitLabel: z.string().max(60).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SOCIETY_REGISTER);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await requestMembership(id, user, body.unitLabel), 201);
});
