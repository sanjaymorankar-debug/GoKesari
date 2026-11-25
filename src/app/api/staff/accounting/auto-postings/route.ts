/**
 * docs/tax-register/BOOKS.md: postings queued by paid payouts (Accountant, CA, admin).
 * GET ?status=PENDING|DRAFTED|DISMISSED → the postings · ?view=liabilities&month=YYYY-MM → TCS / TDS / GST payable
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listAutoPostings, statutoryLiabilities } from "@/server/rbac-accounting/auto-post";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  const p = request.nextUrl.searchParams;
  if (p.get("view") === "liabilities") return ok({ liabilities: await statutoryLiabilities(p.get("month") ?? "") });
  const status = p.get("status");
  return ok({ postings: await listAutoPostings(status === "PENDING" || status === "DRAFTED" || status === "DISMISSED" ? status : undefined) });
});
