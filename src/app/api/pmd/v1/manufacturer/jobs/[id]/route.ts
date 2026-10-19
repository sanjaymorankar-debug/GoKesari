/** GET — progress of one of the key's own import jobs (batch-2026-10 WS-D, F9.1.2). Bearer API key. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { jobProgress } from "@/server/pmd/ingest-jobs";
import { authenticateManufacturerApiKey } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const session = await authenticateManufacturerApiKey(request);
  const id = z.string().uuid().parse((await context.params).id);
  const progress = await jobProgress(id);
  if (progress.manufacturerAccountId !== session.account.id) throw notFound("Import");
  return ok(progress);
});
