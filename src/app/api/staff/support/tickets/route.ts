/**
 * RBAC v2 Phase 4/7: staff tickets. GET ?view=mine (Support User: assigned to me) | raised (tickets I raised);
 * POST raises a ticket about a shop (Operations, Support, admin) — it lands in the Support Manager's queue.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { TICKET_PRIORITIES } from "@/lib/support-ticket-states";
import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listMyAssignedTickets, listRaisedTickets, raiseStaffTicket, STAFF_TICKET_CATEGORIES } from "@/server/rbac-support/desk";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.object({
  shopId: z.string().uuid(),
  category: z.enum(STAFF_TICKET_CATEGORIES),
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  opsTaskId: z.string().uuid().nullish(),
});

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  await requireFeatureForRole("rbac_v2_support", actor.role);
  const { view } = parseQuery(request, z.object({ view: z.enum(["mine", "raised"]).default("mine") }));
  return ok(view === "mine" ? await listMyAssignedTickets(actor) : await listRaisedTickets(actor));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireUser();
  return ok(await raiseStaffTicket(await parseBody(request, schema), actor), 201);
});
