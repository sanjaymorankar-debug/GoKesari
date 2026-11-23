/**
 * RBAC v2 Phase 6: one Operations task.
 *   GET    the task and its history (assignee or Operations Manager)
 *   PATCH  { action: START | NOTE | FOLLOW_UP | DONE | CANCEL | REOPEN }
 *          the assignee may START, NOTE, FOLLOW_UP and DONE; CANCEL and REOPEN are the manager's
 *   POST   { assigneeUserId, note }  reassign (Operations Manager)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getOpsTaskDetail, reassignOpsTask, updateOpsTask } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

const note = z.string().trim().max(2000);
const update = z.discriminatedUnion("action", [
  z.object({ action: z.literal("START"), note: note.nullish() }),
  z.object({ action: z.literal("NOTE"), note: note.min(1) }),
  z.object({ action: z.literal("FOLLOW_UP"), followUpAt: z.coerce.date(), note: note.nullish() }),
  z.object({ action: z.literal("DONE"), outcome: note.min(1) }),
  z.object({ action: z.literal("CANCEL"), note: note.min(1) }),
  z.object({ action: z.literal("REOPEN"), note: note.min(1) }),
]);

const reassign = z.object({ assigneeUserId: z.string().uuid(), note: note.nullish() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  return ok(await getOpsTaskDetail(actor, id));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  return ok(await updateOpsTask(actor, id, await parseBody(request, update)));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  return ok(await reassignOpsTask(actor, id, await parseBody(request, reassign)));
});
