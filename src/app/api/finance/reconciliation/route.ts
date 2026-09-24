/**
 * Reconciliation (Part H).
 * GET ?status=UNMATCHED,PARTIAL,EXCEPTION — records + counts. Admins
 * (FINANCE_VIEW) see every entity; operators (FINANCE_EXCEPTIONS_VIEW) only
 * ORDER / PAYMENT / RIDER records, never settlement or payout totals.
 * POST { from, to } runs the checks and stores the results (FINANCE_MANAGE).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission, requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  countReconciliationByStatus,
  listReconciliationRecords,
  OPERATOR_RECONCILIATION_ENTITIES,
  runReconciliation,
} from "@/server/services/finance";

const STATUSES = ["UNMATCHED", "MATCHED", "PARTIAL", "EXCEPTION", "RECONCILED"] as const;
const querySchema = z.object({ status: z.string().optional() });
const runSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const GET = route(async (request: NextRequest) => {
  const user = await requireAnyPermission([PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW]);
  const { status } = parseQuery(request, querySchema);
  const statuses = (status ?? "").split(",").filter((s): s is (typeof STATUSES)[number] =>
    (STATUSES as readonly string[]).includes(s),
  );
  const entityTypes = can(user.role, PERMISSIONS.FINANCE_VIEW) ? undefined : OPERATOR_RECONCILIATION_ENTITIES;
  const [records, counts] = await Promise.all([
    listReconciliationRecords({ statuses, entityTypes }),
    countReconciliationByStatus(entityTypes),
  ]);
  return ok({ records, counts });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const body = await parseBody(request, runSchema);
  return ok(await runReconciliation(body.from, body.to, user));
});
