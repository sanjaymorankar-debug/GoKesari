/** Edit (PATCH) or retire (DELETE) a canned reply — admin only (F6.3.3, batch-2026-10 WS-C). */
import type { NextRequest } from "next/server";

import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { deleteCannedReply, updateCannedReply } from "@/server/aftercare/support-tickets";
import { cannedSchema } from "../schema";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  return ok(await updateCannedReply(id, await parseBody(request, cannedSchema), user));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await deleteCannedReply(id, await requireUser());
  return noContent();
});
