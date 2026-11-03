/**
 * Dealer commission payout reports (gap report C6), CSV or XLSX.
 * GET ?report=summary|lines|pending|failed&month=YYYY-MM&dealerId=&role=MAIN_DEALER|TEAM_LEAD|AGENT&status=&format=csv|xlsx|json
 * Read-only: ADMIN, OPERATOR and (gap report D4) CA.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireDealerProgramme } from "@/server/dealers/http";
import { PAYOUT_REPORTS, payoutReport, payoutReportFile } from "@/server/dealers/payout-reports";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requirePermission(PERMISSIONS.DEALER_PAYOUTS_READ);
  const p = request.nextUrl.searchParams;
  const report = z.enum(PAYOUT_REPORTS).parse(p.get("report") ?? "summary");
  const filter = {
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).safeParse(p.get("month")).data ?? null,
    dealerId: z.string().uuid().safeParse(p.get("dealerId")).data ?? null,
    role: z.enum(["MAIN_DEALER", "TEAM_LEAD", "AGENT"]).safeParse(p.get("role")).data ?? null,
    status: z.string().max(20).safeParse(p.get("status")).data ?? null,
  };
  const format = p.get("format");
  if (format === "csv" || format === "xlsx") {
    const file = await payoutReportFile(report, filter, format);
    return new NextResponse(new Uint8Array(file.body), {
      headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.filename}"`, "cache-control": "private, no-store" },
    });
  }
  return ok(await payoutReport(report, filter));
});
