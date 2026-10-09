/** GET → the shop's sync log, newest first, in plain words. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { listSyncLog } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "view");
  const log = await listSyncLog(id, 200);
  return ok({ log: log.map((l) => ({ id: l.id, level: l.level, event: l.event, message: l.message, jobId: l.jobId, createdAt: l.createdAt, detail: actor.via === "SUPPORT" ? l.detail : null })) });
});
