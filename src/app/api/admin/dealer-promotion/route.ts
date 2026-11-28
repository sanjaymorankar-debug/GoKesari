/**
 * Admin → Dealers → Promote (owner, 28-Nov-2026). ADMIN or OPERATOR.
 *   GET ?q=                                     shops / dealers matching, grouped by person
 *   POST { action: "promoteShopOwner", shopId, alsoSuper?, agreementStart?, agreementEnd?, reason? }
 *        → 202 a four-eye promotion a different admin / operator confirms
 *   POST { action: "makeSuper", dealerId, reason }
 *        → ADMIN: done at once; OPERATOR: 202 a request a different admin / operator approves
 * src/server/dealers/promotion-admin.ts.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { makeSuperDealer, promoteShopOwner, searchPromotionCandidates } from "@/server/dealers/promotion-admin";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const staff = await requireRole("ADMIN", "OPERATOR");
  return ok({ results: await searchPromotionCandidates(request.nextUrl.searchParams.get("q") ?? "", staff) });
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promoteShopOwner"),
    shopId: z.string().uuid(),
    alsoSuper: z.boolean().optional(),
    agreementStart: z.string().max(10).nullish(),
    agreementEnd: z.string().max(10).nullish(),
    reason: z.string().max(300).nullish(),
  }),
  z.object({ action: z.literal("makeSuper"), dealerId: z.string().uuid(), reason: z.string().max(300) }),
]);

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const staff = await requireRole("ADMIN", "OPERATOR");
  const body = await parseBody(request, schema);
  if (body.action === "promoteShopOwner") {
    const r = await promoteShopOwner(body.shopId, staff, body);
    return ok(r, r.approvalId ? 202 : 200);
  }
  const r = await makeSuperDealer(body.dealerId, staff, body.reason);
  return ok(r, r.approvalId ? 202 : 200);
});
