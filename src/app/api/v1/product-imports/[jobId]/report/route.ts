/**
 * Bulk product upload (docs/product-import-2026-10): the result report — the
 * uploaded rows with `status` (created / updated / deactivated / skipped /
 * failed) and `messages` added. ?format=xlsx (default) or csv; ?rows=problems
 * keeps only the rows that did not go in as written (failed, skipped, not imported).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { buildReport } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const query = z.object({ format: z.enum(["csv", "xlsx"]).default("xlsx"), rows: z.enum(["all", "problems"]).default("all") });

export const GET = route(async (request: NextRequest, context: RouteContext<{ jobId: string }>) => {
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const user = await requireUser();
  const { format, rows } = parseQuery(request, query);
  const report = await buildReport(jobId, format, user, { problemsOnly: rows === "problems" });
  return new NextResponse(new Uint8Array(report.bytes), {
    headers: {
      "Content-Type": report.contentType,
      "Content-Disposition": `attachment; filename="${report.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
