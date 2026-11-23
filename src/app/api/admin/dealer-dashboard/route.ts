/** docs/dealer-platform phase 6: GET ?from&to&scheme&dealerId&state&district&city&dealerStatus&shopStatus[&format=csv] — the admin dashboard data. */
import { NextResponse, type NextRequest } from "next/server";

import { forbidden } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { dashboardFilters } from "@/server/dealers/dashboard-filters";
import { platformDashboard, platformDashboardCsv } from "@/server/dealers/platform-dashboard";
import { isDealerStaff } from "@/server/dealers/staff-access";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  if (!isDealerStaff(user.role)) throw forbidden();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = dashboardFilters(params);
  const actor = { id: user.id, role: user.role };
  if (params.format === "csv") {
    return new NextResponse(await platformDashboardCsv(actor, filters), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="dealer-dashboard-${filters.from}-to-${filters.to}.csv"`, "cache-control": "private, no-store" } });
  }
  return ok(await platformDashboard(actor, filters));
});
