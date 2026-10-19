/**
 * A reply on a ticket (F6.3.3, batch-2026-10 WS-C). Support may also post an
 * internal note, insert a canned reply, and move the ticket on in one step.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { TICKET_STATUSES } from "@/lib/support-ticket-states";
import { replyToTicket } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

const schema = z.object({
  body: z.string().max(5000).nullish(),
  internal: z.boolean().optional(),
  cannedReplyId: z.string().uuid().nullish(),
  thenStatus: z.enum(TICKET_STATUSES).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  enforceRateLimit(`ticket-reply:${user.id}`, RATE_LIMITS.MUTATION);
  const result = await replyToTicket(id, user, await parseBody(request, schema));
  return ok({ messageId: result.message.id, status: result.ticket.status }, 201);
});
