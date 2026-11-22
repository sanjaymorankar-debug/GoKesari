/** Reinstate a suspended user account with a reason. ADMIN only — OPERATOR does not hold USER_SUSPEND. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reinstateUser } from "@/server/services/users";
import { fourEyeAdminOn, requestFourEye, FOUR_EYE_TYPES } from "@/server/approvals";

const schema = z.object({ reason: z.string().trim().min(3).max(500) });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const actor = await requirePermission(PERMISSIONS.USER_SUSPEND);
    const { id } = await context.params;
    const { reason } = await parseBody(request, schema);
    // docs/rbac: with rbac_v2_four_eye_admin on, a second admin approves the reactivation first.
    if (await fourEyeAdminOn()) {
      return ok(
        await requestFourEye(FOUR_EYE_TYPES.USER_REACTIVATE, actor, {
          subjectType: "user",
          subjectId: id,
          title: "Reactivate account",
          reason,
          payload: { userId: id },
        }),
        202,
      );
    }
    return ok(await reinstateUser(id, reason, actor));
  },
);
