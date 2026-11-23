/**
 * docs/delta CF-006: decide or withdraw a rider's request to join a society.
 *   PATCH { action: "approve" | "decline", note? }  society ADMIN (approval lists the rider via addSocietyRider)
 *   PATCH { action: "withdraw" }                     the rider who asked
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { decideJoinRequest, withdrawJoinRequest } from "@/server/services/delta/society-join-requests";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["approve", "decline", "withdraw"]),
  note: z.string().max(300).nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ requestId: string }>) => {
  const user = await requireUser();
  const { requestId } = await context.params;
  const body = await parseBody(request, schema);
  if (body.action === "withdraw") return ok(await withdrawJoinRequest(requestId, user));
  return ok(await decideJoinRequest(requestId, body.action === "approve", user, body.note));
});
