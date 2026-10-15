/** Bulk product upload (docs/product-import-2026-10): cancel an upload before it is imported. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelJob } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ jobId: string }>) => {
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const user = await requireUser();
  return ok(await cancelJob(jobId, user));
});
