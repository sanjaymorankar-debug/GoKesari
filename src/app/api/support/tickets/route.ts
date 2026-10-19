/**
 * Help desk tickets (F6.3.3, batch-2026-10 WS-C).
 *   POST — raise a ticket (customers and shop owners; optionally on an order).
 *   GET  — ?scope=mine (default) the caller's tickets; ?scope=shop the shop
 *          owner's tickets awaiting the shop; ?scope=queue&queue=…&status=…
 *          &category=…&q=… support's queues (staff only).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/support-ticket-states";
import { createTicket, listMyTickets, listShopTickets, listTicketQueue } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  orderId: z.string().uuid().nullish(),
  shopId: z.string().uuid().nullish(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`ticket-create:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, createSchema);
  const ticket = await createTicket(body, user);
  return ok({ id: ticket.id, ticketNumber: ticket.ticketNumber, status: ticket.status, acknowledgeBy: ticket.acknowledgeBy, resolveBy: ticket.resolveBy }, 201);
});

const listSchema = z.object({
  scope: z.enum(["mine", "shop", "queue"]).default("mine"),
  queue: z.enum(["open", "unassigned", "mine", "breached", "escalated", "awaiting", "resolved", "all"]).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  q: z.string().max(100).optional(),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const query = listSchema.parse(params);
  if (query.scope === "shop") return ok({ tickets: await listShopTickets(user) });
  if (query.scope === "queue") {
    return ok({ tickets: await listTicketQueue(user, { queue: query.queue, status: query.status, category: query.category, search: query.q }) });
  }
  return ok({ tickets: await listMyTickets(user) });
});
