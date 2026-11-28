/**
 * POST — ADMIN only: { action: "APPROVE", agreementStart, agreementEnd, mobileConfirmedByCall?,
 * bankVerifiedByDocument? } or { action: "REJECT" | "SUSPEND" | "REACTIVATE" | "TERMINATE", reason }.
 * docs/dealer-programme, GKS-DR-001/002.
 * Owner, 28-Nov-2026: approving a shop owner's promotion (a free franchisee request, or the dealer application of a
 * live shop's owner) answers 202 { pendingApproval, approvalId } — a different admin or operator confirms it
 * (POST /api/approvals/{approvalId}/decide) before the code is issued.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { isShopOwnerPromotion, proposeDealerPromotion } from "@/server/dealers/promotion";
import { decideDealer, dealerView, getDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("APPROVE"),
    agreementStart: z.string().max(10),
    agreementEnd: z.string().max(10),
    mobileConfirmedByCall: z.boolean().optional(),
    bankVerifiedByDocument: z.boolean().optional(),
  }),
  z.object({ action: z.enum(["REJECT", "SUSPEND", "REACTIVATE", "TERMINATE"]), reason: z.string().max(500) }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, schema);
  if (body.action === "APPROVE" && (await isShopOwnerPromotion(await getDealer(id)))) {
    return ok(await proposeDealerPromotion(id, body, admin), 202);
  }
  const result = await decideDealer(id, body, admin);
  return ok({ dealer: await dealerView(result.dealer), code: result.code });
});
