/**
 * One import (batch-2026-10 WS-D, F9.1.4).
 * GET   → progress + validation report (polled by the progress screen)
 * POST { action: "resume" } → back in the queue from its last committed batch (PMD_IMPORT)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertJobAccess } from "@/server/pmd/api-access";
import { getJob, jobProgress, resumeJob } from "@/server/pmd/ingest-jobs";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await assertJobAccess(await getJob(id), user);
  return ok(await jobProgress(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PMD_IMPORT);
  const id = z.string().uuid().parse((await context.params).id);
  await parseBody(request, z.object({ action: z.literal("resume") }));
  return ok(await resumeJob(id, user));
});
