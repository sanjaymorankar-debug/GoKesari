/** RBAC v2 Phase 4: the Support Manager assigns / reassigns, sets priority, due date and side status. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { TICKET_PRIORITIES } from "@/lib/support-ticket-states";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { managerUpdateTicket } from "@/server/rbac-support/desk";

const schema = z.object({
  assigneeId: z.string().uuid().nullish(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  subStatus: z.enum(["PENDING_INFORMATION", "ON_HOLD", "REJECTED"]).nullish(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.SUPPORT_QUEUE_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(
    await managerUpdateTicket(
      id,
      {
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        priority: body.priority,
        ...(body.subStatus !== undefined ? { subStatus: body.subStatus } : {}),
        dueAt: body.dueAt,
        note: body.note,
      },
      actor,
    ),
  );
});
