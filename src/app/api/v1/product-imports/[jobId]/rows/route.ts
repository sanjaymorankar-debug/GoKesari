/**
 * Bulk product upload (docs/product-import-2026-10): the preview (before the
 * commit) or result (after it) rows, 50 a page.
 *   ?status=all|warnings|ready|skipped|created|updated|deactivated|failed  &page=1  &pageSize=50
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listJobRows, loadJobForActor, ROW_FILTERS } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const query = z.object({
  status: z.enum(ROW_FILTERS).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route(async (request: NextRequest, context: RouteContext<{ jobId: string }>) => {
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const user = await requireUser();
  await loadJobForActor(jobId, user);
  const q = parseQuery(request, query);
  return ok(await listJobRows(jobId, { filter: q.status, page: q.page, pageSize: q.pageSize }));
});
