/**
 * POST — ADMIN only: { action: "APPROVE", agreementStart, agreementEnd, mobileConfirmedByCall?,
 * bankVerifiedByDocument? } or { action: "REJECT" | "SUSPEND" | "REACTIVATE" | "TERMINATE", reason }.
 * docs/dealer-programme, GKS-DR-001/002.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { decideDealer, dealerView } from "@/server/dealers/service";

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
  const result = await decideDealer(id, body, admin);
  return ok({ dealer: await dealerView(result.dealer), code: result.code });
});
