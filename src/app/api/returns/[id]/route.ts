/**
 * One return: detail (GET) and the actions the workflow allows (PATCH).
 *   customer: cancel, schedule
 *   shop / staff: approve, reject, receive, inspect, issue_refund, retry_pickup
 *   staff: complete_pickup (when the handover code could not be used)
 * The service checks the caller may act and that the move is legal. Every
 * action answers with the updated case as GET shows it to the caller.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { completePickupByOperator, retryPickup, scheduleReturnPickup } from "@/server/services/return-pickups";
import {
  approveReturn,
  cancelReturn,
  getReturnDetail,
  inspectReturn,
  issueRefund,
  receiveReturn,
  rejectReturn,
} from "@/server/services/returns";
import { forbidden } from "@/lib/errors";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("schedule"), scheduledFor: z.string().datetime() }),
  z.object({ action: z.literal("approve"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().min(3).max(500) }),
  z.object({ action: z.literal("receive") }),
  z.object({
    action: z.literal("inspect"),
    outcome: z.enum(["ACCEPT", "REJECT"]),
    note: z.string().min(3).max(500),
    refundPaise: z.number().int().positive().optional(),
  }),
  z.object({ action: z.literal("issue_refund") }),
  z.object({ action: z.literal("retry_pickup") }),
  z.object({ action: z.literal("complete_pickup"), note: z.string().min(5).max(500) }),
]);

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok(await getReturnDetail(id, user));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);

  switch (body.action) {
    case "cancel":
      await cancelReturn(id, user, body.note);
      break;
    case "schedule":
      await scheduleReturnPickup(id, user.id, new Date(body.scheduledFor));
      break;
    case "approve":
      await approveReturn(id, user, body.note);
      break;
    case "reject":
      await rejectReturn(id, user, body.note);
      break;
    case "receive":
      await receiveReturn(id, user);
      break;
    case "inspect":
      await inspectReturn(id, user, body);
      break;
    case "issue_refund":
      await issueRefund(id, user);
      break;
    case "retry_pickup": {
      // Managing rights are re-checked by the return service on the next action; here only shop/staff may retry.
      const { viewer } = await getReturnDetail(id, user); // view check
      if (viewer === "CUSTOMER") throw forbidden("Only the shop or support can retry a pickup.");
      await retryPickup(id);
      break;
    }
    case "complete_pickup": {
      if (user.role !== "OPERATOR" && user.role !== "ADMIN") throw forbidden("Only support can complete a pickup.");
      await completePickupByOperator(id, user, body.note);
      break;
    }
  }
  // The case as this caller sees it (same as GET), never the raw rows: those
  // carry the customer's address, staff ids and the pickup's handover code.
  return ok(await getReturnDetail(id, user));
});
