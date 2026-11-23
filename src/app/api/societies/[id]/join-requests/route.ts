/**
 * docs/delta CF-006: riders ask to join a society's rider list.
 *   POST { message? }  an approved rider asks (201; a repeat while one is pending returns that one)
 *   GET                the society's pending requests (society ADMIN/OPERATOR or platform staff)
 * Behind society_rider_join_requests_enabled (by the society's district); off → 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { listSocietyJoinRequests, requestToJoinSociety } from "@/server/services/delta/society-join-requests";

export const dynamic = "force-dynamic";

const schema = z.object({ message: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  enforceRateLimit(`society-join:${user.id}`, { limit: 20, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  return ok(await requestToJoinSociety(id, user, body.message), 201);
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok(await listSocietyJoinRequests(id, user));
});
