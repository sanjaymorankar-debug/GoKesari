/**
 * Monthly exports for GoKesari's CA (PLATFORM_INVOICE_MANAGE):
 *   ?type=gstr1  GoKesari's own supplies (fee invoices and notes), GSTR-1-ready
 *   ?type=tcs    GST TCS collected (GSTR-8-style)
 *   ?type=tds    income-tax TDS on e-commerce participants
 * &period=YYYY-MM&format=csv|json. Every export is audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { fileResponse } from "@/server/payouts/http";
import { exportStatutoryReport } from "@/server/payouts/reports";

const schema = z.object({
  type: z.enum(["gstr1", "tcs", "tds"]),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  format: z.enum(["csv", "json"]).default("csv"),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PLATFORM_INVOICE_MANAGE);
  const query = parseQuery(request, schema);
  const report = await exportStatutoryReport(query.type, query.period, user);
  const name = `gokesari-${query.type}-${query.period}`;
  return query.format === "json"
    ? fileResponse(JSON.stringify(report.json, null, 2), `${name}.json`, "application/json")
    : fileResponse(report.csv, `${name}.csv`, "text/csv; charset=utf-8");
});
