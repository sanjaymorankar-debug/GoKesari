/** Suspend a user account with a reason. ADMIN only — OPERATOR does not hold USER_SUSPEND. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { suspendUser } from "@/server/services/users";
import { emergencySuspend, fourEyeAdminOn } from "@/server/approvals";

const schema = z.object({ reason: z.string().trim().min(3).max(500) });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const actor = await requirePermission(PERMISSIONS.USER_SUSPEND);
    const { id } = await context.params;
    const { reason } = await parseBody(request, schema);
    // docs/rbac: with rbac_v2_four_eye_admin on, a suspension is an emergency action — it applies at
    // once and a second admin must confirm it within 24 hours (rejecting lifts it).
    if (await fourEyeAdminOn()) return ok(await emergencySuspend(id, reason, actor));
    return ok(await suspendUser(id, reason, actor));
  },
);
