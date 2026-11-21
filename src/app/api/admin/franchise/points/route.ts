/** Admin / operator: GET ?month=YYYY-MM&format=json|xlsx — the dealer monthly points table (brief 21-Nov §7). */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { pointsTable, pointsWorkbook } from "@/server/franchise/dashboard";
import { requireFranchiseReader } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireFranchiseReader();
  const q = parseQuery(request, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), format: z.enum(["json", "xlsx"]).optional() }));
  const rows = await pointsTable(q.month);
  if (q.format === "xlsx") {
    const buf = await pointsWorkbook(rows);
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="franchise-points-${q.month ?? "all"}.xlsx"` } });
  }
  return ok({ rows });
});
