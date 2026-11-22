/**
 * RBAC v2 Phase 6 (docs/rbac/06-operations.md): Operations tasks.
 *   GET   ?status=ACTIVE|DONE|ALL&assignee=&shopId=   Operations User: own tasks; Manager: the team's
 *   POST  create and assign a task                    Operations Manager (OPS_TEAM_MANAGE)
 * Permissions, flag (rbac_v2_operations) and data scope are enforced in src/server/rbac-operations.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { OPS_TASK_KINDS, OPS_TASK_PRIORITIES } from "@/server/db/ops-schema";
import { createOpsTask, listOpsTasks } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

const query = z.object({
  status: z.enum(["ACTIVE", "DONE", "ALL"]).default("ACTIVE"),
  assignee: z.string().uuid().optional(),
  shopId: z.string().uuid().optional(),
});

const body = z.object({
  kind: z.enum(OPS_TASK_KINDS),
  title: z.string().trim().min(3).max(200),
  notes: z.string().trim().max(2000).nullish(),
  priority: z.enum(OPS_TASK_PRIORITIES).default("NORMAL"),
  assigneeUserId: z.string().uuid(),
  shopId: z.string().uuid().nullish(),
  customerUserId: z.string().uuid().nullish(),
  zoneId: z.string().trim().max(40).nullish(),
  dueAt: z.coerce.date().nullish(),
});

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const q = parseQuery(request, query);
  return ok(await listOpsTasks(actor, { status: q.status, assigneeUserId: q.assignee, shopId: q.shopId }));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const b = await parseBody(request, body);
  return ok(await createOpsTask(actor, b), 201);
});
