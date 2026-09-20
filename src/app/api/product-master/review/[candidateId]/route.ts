/**
 * POST /api/product-master/review/{candidateId}   { "decision": "CONFIRMED_SAME" | "CONFIRMED_DIFFERENT" | "SAME_FAMILY", "note": "..." }
 * A person resolves a review item. CONFIRMED_SAME merges by pointer (nothing is deleted).
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { guarded } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { decideCandidate } from "@/server/pmd/pipeline/review";
import { decisionBodySchema } from "@/server/pmd/schemas";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ candidateId: string }>) => {
  const user = await requirePermission(PERMISSIONS.PMD_REVIEW);
  const raw = (await context.params).candidateId;
  if (!/^\d{1,12}$/.test(raw)) throw validationFailed("Review item id must be a number.");
  const candidateId = Number(raw);
  const body = await parseBody(request, decisionBodySchema);

  const result = await guarded(() =>
    decideCandidate(appSql(), candidateId, body.decision, { userId: user.id, label: user.email || user.id }, body.note ?? null),
  );
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.PMD_MATCH_DECIDED,
    entityType: "pmd_match_candidate",
    entityId: String(candidateId),
    newValue: { decision: body.decision, note: body.note ?? null, merged: result.merged ?? null, linkedHeldRecord: result.linkedHeldRecord ?? false },
  });
  return ok(result);
});
