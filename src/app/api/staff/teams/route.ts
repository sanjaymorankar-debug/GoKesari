/** RBAC v2: Support / Operations teams. GET ?team=&managerId=; POST add; DELETE ?team=&memberId= remove (admin or the team's manager). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { STAFF_TEAMS } from "@/server/db/schema";
import { addTeamMember, listTeam, removeTeamMember } from "@/server/rbac-support/desk";

export const dynamic = "force-dynamic";
const ANY = [PERMISSIONS.STAFF_TEAM_VIEW, PERMISSIONS.APPROVAL_VIEW_ANY];

export const GET = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission(ANY);
  const q = parseQuery(request, z.object({ team: z.enum(STAFF_TEAMS), managerId: z.string().uuid().optional() }));
  return ok(await listTeam(q.team, actor.role === "ADMIN" && q.managerId ? q.managerId : actor.id));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission(ANY);
  const body = await parseBody(request, z.object({ team: z.enum(STAFF_TEAMS), managerUserId: z.string().uuid(), memberUserId: z.string().uuid() }));
  return ok(await addTeamMember(body.team, body.managerUserId, body.memberUserId, actor), 201);
});

export const DELETE = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission(ANY);
  const q = parseQuery(request, z.object({ team: z.enum(STAFF_TEAMS), memberId: z.string().uuid() }));
  await removeTeamMember(q.team, q.memberId, actor);
  return ok({ removed: true });
});
