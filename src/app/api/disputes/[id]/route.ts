/**
 * One dispute case (GS-058). GET is readable by the customer who raised it and
 * by staff. PATCH is the staff-only lifecycle: advance, escalate or resolve.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { DISPUTE_OUTCOMES, DISPUTE_STATUSES } from "@/lib/dispute-states";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { advanceDispute, escalateDispute, getDispute, resolveDispute } from "@/server/services/disputes";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const detail = await getDispute(id, user);
  if (!detail) throw notFound("Dispute");
  return ok(detail);
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("advance"),
    // RESOLVED and ESCALATED are deliberately absent: each has its own action
    // because each records something a bare status change cannot.
    to: z.enum(DISPUTE_STATUSES).refine((s) => s !== "RESOLVED" && s !== "ESCALATED", {
      message: "Use the resolve or escalate action.",
    }),
    note: z.string().max(2000).nullish(),
    proposal: z.string().max(2000).nullish(),
  }),
  z.object({ action: z.literal("escalate"), note: z.string().min(3).max(2000) }),
  z.object({
    action: z.literal("resolve"),
    outcome: z.enum(DISPUTE_OUTCOMES),
    notes: z.string().min(3).max(2000),
    refundPaise: z.number().int().positive().optional(),
    chargeTo: z.enum(["SHOP", "PLATFORM"]).optional(),
    requestId: z.string().min(8).max(100),
  }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DISPUTE_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, patchSchema);

  switch (body.action) {
    case "advance":
      return ok(await advanceDispute(id, { to: body.to, note: body.note, proposal: body.proposal }, user));
    case "escalate":
      return ok(await escalateDispute(id, { trigger: "MANUAL", note: body.note }, user));
    case "resolve":
      return ok(
        await resolveDispute(
          id,
          {
            outcome: body.outcome,
            notes: body.notes,
            refundPaise: body.refundPaise,
            chargeTo: body.chargeTo,
            requestId: body.requestId,
          },
          user,
        ),
      );
  }
});
