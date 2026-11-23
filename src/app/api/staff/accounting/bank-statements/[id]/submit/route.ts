/** RBAC v2 Phase 3 bank reconciliation: the Accountant submits a fully matched statement to the CA for sign-off. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitStatement } from "@/server/rbac-accounting/bank-reconciliation";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.BANK_RECON_PREPARE);
  const id = z.string().uuid().parse((await context.params).id);
  return ok(await submitStatement(id, actor));
});
