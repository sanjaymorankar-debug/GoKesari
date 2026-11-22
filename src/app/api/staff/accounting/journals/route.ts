/** RBAC v2 Phase 3: journal entries. GET (Accountant, CA, Admin) list; POST (Accountant) a draft. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { JOURNAL_STATUSES } from "@/server/db/schema";
import { createJournalDraft, listJournals } from "@/server/rbac-accounting/journals";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { journalSchema } from "@/server/rbac-accounting/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  const q = parseQuery(request, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), status: z.enum(JOURNAL_STATUSES).optional() }));
  return ok(await listJournals({ periodCode: q.period, status: q.status }));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE]);
  const body = await parseBody(request, journalSchema);
  return ok(await createJournalDraft(body, actor), 201);
});
