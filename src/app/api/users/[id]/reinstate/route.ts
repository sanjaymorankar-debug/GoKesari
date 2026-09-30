/** Reinstate a suspended user account with a reason. ADMIN only — OPERATOR does not hold USER_SUSPEND. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reinstateUser } from "@/server/services/users";

const schema = z.object({ reason: z.string().trim().min(3).max(500) });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const actor = await requirePermission(PERMISSIONS.USER_SUSPEND);
    const { id } = await context.params;
    const { reason } = await parseBody(request, schema);
    return ok(await reinstateUser(id, reason, actor));
  },
);
