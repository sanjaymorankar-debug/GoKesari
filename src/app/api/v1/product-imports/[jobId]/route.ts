/** Bulk product upload (docs/product-import-2026-10): one import's status and summary (poll while parsing / importing). */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getJobView, loadJobForActor, parseNeedsRestart, runParse } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ jobId: string }>) => {
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const user = await requireUser();
  await loadJobForActor(jobId, user);
  // A preview whose background task was lost (server restart) is started again.
  if (await parseNeedsRestart(jobId)) {
    after(async () => {
      try {
        await runParse(jobId);
      } catch (error) {
        console.error("[product-import] parse failed", jobId, error);
      }
    });
  }
  return ok(await getJobView(jobId));
});
