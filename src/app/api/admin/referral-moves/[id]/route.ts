/** Admin: POST { action: "approve" | "reject" | "cancel", note } on a referral move request (a different admin decides). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { cancelMoveRequest, decideMoveRequest } from "@/server/dealers/referral-moves";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const admin = await requireRole("ADMIN");
  const { id } = await params;
  const b = await parseBody(request, z.object({ action: z.enum(["approve", "reject", "cancel"]), note: z.string().min(5).max(500) }));
  if (b.action === "cancel") return ok(await cancelMoveRequest(id, b.note, admin));
  return ok(await decideMoveRequest(id, { approve: b.action === "approve", note: b.note }, admin));
});
