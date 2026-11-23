/**
 * RBAC v2 Phase 3: one bank statement with its lines (?status=UNMATCHED|MATCHED|EXCLUDED), or ?format=csv for the
 * reconciliation file. DELETE: the Accountant removes an open statement imported by mistake.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission, requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { BANK_LINE_STATUSES } from "@/server/db/schema";
import { assertBankReconViewer, deleteStatement, getStatement, statementCsv } from "@/server/rbac-accounting/bank-reconciliation";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.BANK_RECON_PREPARE, PERMISSIONS.BANK_RECON_SIGNOFF]);
  await assertBankReconViewer(actor);
  const id = idSchema.parse((await context.params).id);
  const q = parseQuery(request, z.object({ status: z.enum(BANK_LINE_STATUSES).optional(), format: z.enum(["json", "csv"]).default("json") }));
  if (q.format === "csv") {
    const { filename, csv } = await statementCsv(id);
    return new NextResponse(csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" },
    });
  }
  return ok(await getStatement(id, { status: q.status }));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.BANK_RECON_PREPARE);
  await deleteStatement(idSchema.parse((await context.params).id), actor);
  return ok({ deleted: true });
});
