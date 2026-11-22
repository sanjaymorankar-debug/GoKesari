/** Change a user's role (§5). ADMIN only — OPERATOR does not hold USER_SET_ROLE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { userRoleEnum } from "@/server/db/schema";
import { setUserRole } from "@/server/services/users";
import { fourEyeAdminOn, requestFourEye, FOUR_EYE_TYPES } from "@/server/approvals";
import { forbidden } from "@/lib/errors";


const schema = z.object({ role: z.enum(userRoleEnum.enumValues) });

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const actor = await requirePermission(PERMISSIONS.USER_SET_ROLE);
    const { id } = await context.params;
    const { role } = await parseBody(request, schema);
    // docs/rbac: with rbac_v2_four_eye_admin on, a second admin approves the change first.
    if (await fourEyeAdminOn()) {
      if (id === actor.id) throw forbidden("You cannot change your own role.");
      return ok(
        await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, actor, {
          subjectType: "user",
          subjectId: id,
          title: `Set role to ${role}`,
          reason: `Role change to ${role}`,
          payload: { userId: id, role },
        }),
        202,
      );
    }
    return ok(await setUserRole(id, role, actor));
  },
);
