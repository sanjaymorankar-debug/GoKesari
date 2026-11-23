/**
 * docs/dealer-platform phase 6: POST { versionId, reason } — moves a dealer to a scheme version he accepted
 * (DEALER_REASSIGN; a Regional Admin in his regions). With dealer_platform_four_eye on, a second admin approves.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { dealerFourEyeOn, requestDealerApproval } from "@/server/approvals";
import { changeDealerScheme } from "@/server/dealers/scheme-change";
import { requireDealerPermission } from "@/server/dealers/staff-access";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const actor = { id: user.id, role: user.role };
  requireDealerPermission(actor, PERMISSIONS.DEALER_REASSIGN, "change a dealer's scheme");
  const { id } = await context.params;
  const body = await parseBody(request, z.object({ versionId: z.string().uuid(), reason: z.string().trim().min(5).max(500) }));
  if (await dealerFourEyeOn()) return ok(await requestDealerApproval({ type: "DEALER_SCHEME_CHANGE", actor, subjectType: "dealer", subjectId: id, title: "Move a dealer to another scheme", reason: body.reason, payload: { dealerId: id, versionId: body.versionId } }), 202);
  await changeDealerScheme(actor, id, body.versionId, body.reason);
  return ok({ changed: true });
});
