/**
 * The signed-in user's roles (GS-003): list them, or switch the active role.
 * Only roles the user already holds can be chosen.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { userRoleEnum } from "@/server/db/schema";
import { listUserRoles, switchActiveRole } from "@/server/services/roles";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ active: user.role, roles: await listUserRoles(user.id) });
});

const schema = z.object({ role: z.enum(userRoleEnum.enumValues) });

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  const { role } = await parseBody(request, schema);
  const active = await switchActiveRole(user.id, role);
  return ok({ active, roles: await listUserRoles(user.id) });
});
