/** RBAC v2 Phase 3: the Accountant drafts a reversing entry of a posted one (it then goes to the CA). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createReversal } from "@/server/rbac-accounting/journals";

const schema = z.object({ entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(5).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.JOURNAL_PREPARE);
  const { id } = await context.params;
  return ok(await createReversal(id, await parseBody(request, schema), actor), 201);
});
