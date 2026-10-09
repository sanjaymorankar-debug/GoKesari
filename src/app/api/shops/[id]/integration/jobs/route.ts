/** GET ?status=DEAD,FAILED → sync entries (invoices, credit notes, pulls), newest first, with owner-readable errors. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { describeError } from "@/server/integrations/errors";
import { listJobs } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";

const STATUSES = ["PENDING", "CLAIMED", "SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] as const;

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "view");
  const { status } = parseQuery(request, z.object({ status: z.string().optional() }));
  const wanted = status ? z.array(z.enum(STATUSES)).parse(status.split(",")) : undefined;
  const jobs = await listJobs(id, { status: wanted, limit: 200 });
  return ok({
    jobs: jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      number: (j.payload.number as string | undefined) ?? ((j.payload.document as { number?: string } | undefined)?.number ?? null),
      subjectType: j.subjectType,
      subjectId: j.subjectId,
      attempts: j.attempts,
      nextAttemptAt: j.nextAttemptAt,
      externalRef: j.externalRef,
      error: j.errorCode ? { code: j.errorCode, ...describeError(j.errorCode), message: j.errorMessage ?? describeError(j.errorCode).message } : null,
      // Technical detail is for support only.
      errorDetail: actor.via === "SUPPORT" ? j.errorDetail : null,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
    })),
  });
});
