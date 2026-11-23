/** RBAC v2 Phase 3: the preparer submits a journal entry. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitJournal } from "@/server/rbac-accounting/journals";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.JOURNAL_PREPARE);
  const { id } = await context.params;
  return ok(await submitJournal(id, actor));
});
