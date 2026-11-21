/** Admin / operator: GET ?kind=fees|occupancy|owners|commission&format=json|csv — franchise reports (brief §10). */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { franchiseReport, toCsv } from "@/server/franchise/dashboard";
import { requireFranchiseReader } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireFranchiseReader();
  const q = parseQuery(request, z.object({ kind: z.enum(["fees", "occupancy", "owners", "commission"]), format: z.enum(["json", "csv"]).optional() }));
  const report = await franchiseReport(q.kind);
  if (q.format === "csv") {
    return new NextResponse(toCsv(report), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="franchise-${q.kind}.csv"` } });
  }
  return ok(report);
});
