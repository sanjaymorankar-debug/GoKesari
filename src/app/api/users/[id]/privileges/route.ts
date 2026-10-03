/**
 * A user's whole privileges draft, saved in one request (admin privileges
 * screen). ADMIN only — OPERATOR does not hold USER_SET_ROLE.
 *
 * `PATCH /api/users/{id}/privileges` replaces both the active role and the set
 * of held roles atomically. The older single-field endpoints
 * (`PATCH .../role`, `DELETE .../roles`) remain for API callers.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { userRoleEnum } from "@/server/db/schema";
import { getUserPrivileges, updateUserPrivileges } from "@/server/services/users";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  return ok(await getUserPrivileges(id));
});

const schema = z.object({
  activeRole: z.enum(userRoleEnum.enumValues),
  heldRoles: z.array(z.enum(userRoleEnum.enumValues)).max(userRoleEnum.enumValues.length),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateUserPrivileges(id, body, actor));
});
