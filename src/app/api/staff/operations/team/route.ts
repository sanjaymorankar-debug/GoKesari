/**
 * RBAC v2 Phase 6: the Operations team and zones (Operations Manager).
 *   GET                                   members with zones and workload, and the zone list
 *   POST   { userId, zoneId, reason }     give a user a franchise zone
 *   DELETE ?assignmentId=                 end a zone assignment (kept as history)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { assignZone, endZoneAssignment, listOpsTeam, listZones } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const actor = await requireUser();
  const [members, zones] = await Promise.all([listOpsTeam(actor), listZones(actor)]);
  return ok({ members, zones });
});

const assign = z.object({ userId: z.string().uuid(), zoneId: z.string().trim().min(1).max(40), reason: z.string().trim().max(500).nullish() });

export const POST = route(async (request: NextRequest) => {
  const actor = await requireUser();
  return ok(await assignZone(actor, await parseBody(request, assign)), 201);
});

export const DELETE = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const { assignmentId } = parseQuery(request, z.object({ assignmentId: z.string().uuid() }));
  await endZoneAssignment(actor, assignmentId);
  return noContent();
});
