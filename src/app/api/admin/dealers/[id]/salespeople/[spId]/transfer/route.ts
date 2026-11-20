/** Admin: POST { toDealerId, reason } — move a team lead / agent to another dealer's team (franchise brief §2.4). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { transferMemberToDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string; spId: string }>) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, z.object({ toDealerId: z.string().uuid(), reason: z.string().min(5).max(300) }));
  return ok(await transferMemberToDealer((await params).spId, body.toDealerId, body.reason, admin), 201);
});
