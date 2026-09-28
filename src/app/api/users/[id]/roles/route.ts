/**
 * A user's role grants (GS-003). ADMIN (USER_SET_ROLE): list them, or revoke
 * one — the user falls back to CUSTOMER if it was their active role.
 * Granting stays on PATCH /api/users/{id}/role.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { userRoleEnum } from "@/server/db/schema";
import { listRoleGrants, revokeRole } from "@/server/services/roles";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  return ok(await listRoleGrants(id));
});

const schema = z.object({ role: z.enum(userRoleEnum.enumValues) });

export const DELETE = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  const { role } = parseQuery(request, schema);
  await revokeRole(id, role, actor);
  return ok(await listRoleGrants(id));
});
