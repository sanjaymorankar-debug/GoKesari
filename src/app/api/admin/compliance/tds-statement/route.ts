/**
 * Billing v2 (docs/billing §5.5): the quarterly TDS statement as CSV with full
 * PANs, for the filing utility (Form 140 data). Admin only (STATUTORY_MANAGE);
 * every download is audited as a PAN reveal.
 */
import { NextResponse, type NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireFeature } from "@/server/services/feature-flags";
import { tdsStatementCsv } from "@/server/tax/compliance";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  await requireFeature("tds_engine");
  const quarter = request.nextUrl.searchParams.get("quarter") ?? "";
  if (!/^\d{4}-\d{2}-Q[1-4]$/.test(quarter)) throw validationFailed("Choose a quarter (e.g. 2026-27-Q3).");
  const csv = await tdsStatementCsv(quarter, user);
  return new NextResponse(csv, {
    headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="tds-statement-${quarter}.csv"`, "cache-control": "private, no-store" },
  });
});
