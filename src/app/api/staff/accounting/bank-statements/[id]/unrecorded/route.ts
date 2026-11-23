/** RBAC v2 Phase 3 bank reconciliation: payouts and refunds recorded as paid in the statement's dates that no bank line matches. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertBankReconViewer, unmatchedBookItems } from "@/server/rbac-accounting/bank-reconciliation";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.BANK_RECON_PREPARE, PERMISSIONS.BANK_RECON_SIGNOFF]);
  await assertBankReconViewer(actor);
  return ok(await unmatchedBookItems(z.string().uuid().parse((await context.params).id)));
});
