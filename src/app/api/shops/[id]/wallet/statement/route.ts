/**
 * The shop wallet's monthly ledger as a CSV file (docs/flows-v3/wave1.md, F14; flag flow_f14 — "not available"
 * while it is off). The same statement as Accounts → Statements (billing v2), without needing billing v2.
 * The shop's owner, or finance staff for any shop.
 *
 * GET ?period=YYYY-MM (default: this month, India time)
 */
import { NextResponse, type NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { PERMISSIONS } from "@/server/authz/permissions";
import { featureNotAvailable, isFeatureEnabled } from "@/server/services/feature-flags";
import { shopStatementFiles } from "@/server/tax/statements";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  if (!(await isFeatureEnabled("flow_f14").catch(() => false))) throw featureNotAvailable("flow_f14");
  await requireShopPermission(id, "billing.view", { anyPermission: PERMISSIONS.FINANCE_VIEW });
  const thisMonth = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
  const period = new URL(request.url).searchParams.get("period") ?? thisMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw validationFailed("Use a month such as 2026-11.");
  const f = await shopStatementFiles(id, "wallet", period, "csv");
  return new NextResponse(new Uint8Array(f.bytes), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${f.filename}"`,
      "cache-control": "private, no-store",
    },
  });
});
