/**
 * GET /api/product-master/data-quality
 * The quality dashboard as data: totals, missing-field counts, conflicts, review load, and breakdowns
 * by marketplace / category / brand. Served from a snapshot refreshed after every run.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { getDataQualityReport } from "@/server/pmd/services/reference";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  return ok(await getDataQualityReport(appSql()));
});
