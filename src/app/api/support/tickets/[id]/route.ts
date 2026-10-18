/**
 * One help desk ticket (F6.3.3, batch-2026-10 WS-C).
 *   GET   — the ticket as this viewer may see it (internal notes only for support).
 *   PATCH — { action: "status", status, note } support: any legal move;
 *           the requester: close / reopen a resolved ticket.
 *           { action: "assign", assigneeId } and { action: "escalate", why } — support.
 * Anyone without access gets 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { TICKET_STATUSES } from "@/lib/support-ticket-states";
import { assignTicket, changeTicketStatus, escalateTicket, getTicketDetail } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  return ok(await getTicketDetail(id, await requireUser()));
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), status: z.enum(TICKET_STATUSES), note: z.string().max(2000).nullish() }),
  z.object({ action: z.literal("assign"), assigneeId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("escalate"), why: z.string().min(3).max(500) }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  const body = await parseBody(request, patchSchema);
  if (body.action === "assign") return ok(await assignTicket(id, body.assigneeId, user));
  if (body.action === "escalate") return ok(await escalateTicket(id, user, body.why));
  return ok(await changeTicketStatus(id, body.status, user, body.note));
});
