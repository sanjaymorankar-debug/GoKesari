/**
 * RBAC v2 approval requests (docs/rbac). GET ?status=PENDING|ALL
 *   ADMIN (APPROVAL_VIEW_ANY)  every request
 *   CA (JOURNAL_APPROVE)       requests a CA checks (CA, and CA_THEN_ADMIN)
 * Everyone else: 403. Shop owners see their own change requests on the shop pages (Phase 5).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listApprovals } from "@/server/approvals";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["PENDING", "ALL"]).default("PENDING") });

export const GET = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.APPROVAL_VIEW_ANY, PERMISSIONS.JOURNAL_APPROVE]);
  const { status } = parseQuery(request, schema);
  const statuses = status === "PENDING" ? ["PENDING"] : undefined;
  const checkers = can(actor.role, PERMISSIONS.APPROVAL_VIEW_ANY) ? undefined : (["CA", "CA_THEN_ADMIN"] as const);
  return ok(await listApprovals({ statuses, checkers: checkers ? [...checkers] : undefined }));
});
