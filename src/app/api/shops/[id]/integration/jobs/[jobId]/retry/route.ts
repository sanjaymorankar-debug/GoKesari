/** POST → sends a failed entry again (after the owner fixed the cause). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { retryJob } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string; jobId: string }>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const actor = await requireIntegrationAccess(id, "operate");
  await retryJob(id, z.string().uuid().parse(params.jobId), actor);
  return noContent();
});
