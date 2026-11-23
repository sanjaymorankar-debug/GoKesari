/** RBAC v2 Phase 3: one journal entry (GET) or edit a draft / rejected entry (PUT, the preparer). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getJournal, updateJournalDraft } from "@/server/rbac-accounting/journals";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { journalSchema } from "@/server/rbac-accounting/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  const { id } = await context.params;
  return ok(await getJournal(id));
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE]);
  const { id } = await context.params;
  return ok(await updateJournalDraft(id, await parseBody(request, journalSchema), actor));
});
