/**
 * Product-data import worker (batch-2026-10 WS-D, F9.1.4). Schedule every minute:
 *   curl -X POST https://<host>/api/cron/pmd-ingest -H "Authorization: Bearer $CRON_SECRET"
 *
 * Each runnable import gets up to pmdSources.ingestBatchesPerTick batches of
 * pmdSources.ingestBatchSize rows; every batch ends in a checkpoint, so an
 * import interrupted anywhere resumes after its last committed batch. Leases
 * keep two overlapping runs off the same import. Safe to overlap.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { processDueJobs } from "@/server/pmd/ingest-jobs";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await processDueJobs();
  const summary = { jobs: result.jobs, errors: result.errors, progressed: result.progressed.map((p) => ({ id: p.id, status: p.status, percent: p.percent })) };
  console.info("[cron:pmd-ingest]", JSON.stringify(summary));
  return ok(summary);
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
