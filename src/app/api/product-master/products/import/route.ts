/**
 * POST /api/product-master/products/import   { "rows": [ ...up to 1000 staged products ] }
 * Runs the ordinary pipeline (normalise -> match -> validate -> load) through the manual_import source.
 * Admin only: it writes to the master. Bad rows are reported, never fatal.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { guarded } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { importBodySchema } from "@/server/pmd/schemas";
import { importProducts } from "@/server/pmd/services/ingest-api";
import type { StagedProduct } from "@/server/pmd/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_IMPORT);
  const { rows } = await parseBody(request, importBodySchema);
  const summary = await guarded(() => importProducts(appSql(), rows as StagedProduct[], user.email || user.id));
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.PMD_PRODUCTS_IMPORTED,
    entityType: "pmd_ingestion_run",
    entityId: String(summary.runId),
    newValue: { rows: rows.length, ...summary.counters },
  });
  return ok(summary, 201);
});
