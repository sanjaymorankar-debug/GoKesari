/**
 * RBAC v2 Phase 6: Operations Manager reports (OPS_REPORT_VIEW).
 *   GET ?kind=shops&days=30                  shop onboarding monitor
 *   GET ?kind=customers                      customer onboarding monitor
 *   GET ?kind=activity&period=day|week&date= activity per user and zone (IST)
 *   GET ?kind=excel&period=…&date=&days=     the three as one .xlsx download
 *   GET ?kind=pdf&period=…&date=&days=       the same as a printable A4 PDF
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { buildOpsReportPdf, buildOpsReportWorkbook, getCustomerOnboardingMonitor, getOpsActivityReport, getShopOnboardingMonitor } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

const query = z.object({
  kind: z.enum(["shops", "customers", "activity", "excel", "pdf"]),
  days: z.coerce.number().int().min(1).max(365).optional(),
  period: z.enum(["day", "week"]).default("day"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const q = parseQuery(request, query);
  if (q.kind === "shops") return ok(await getShopOnboardingMonitor(actor, { days: q.days }));
  if (q.kind === "customers") return ok(await getCustomerOnboardingMonitor(actor));
  if (q.kind === "activity") return ok(await getOpsActivityReport(actor, { period: q.period, date: q.date }));
  const pdf = q.kind === "pdf";
  const opts = { period: q.period, date: q.date, days: q.days };
  const { filename, buffer } = pdf ? await buildOpsReportPdf(actor, opts) : await buildOpsReportWorkbook(actor, opts);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
