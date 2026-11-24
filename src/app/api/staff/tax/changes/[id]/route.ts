/**
 * docs/tax-register: decide on a change request.
 * POST { action: "approve", note? }          the CA (never their own) — applied at once
 *      { action: "sendBack", note }          the CA
 *      { action: "withdraw" }                the proposer (or an admin)
 *      { action: "resubmit", kind, payload, reason, legalReference? }  the proposer, after a send-back
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { approveTaxChange, proposeSchema, resubmitTaxChange, sendBackTaxChange, withdrawTaxChange } from "@/server/tax-register/changes";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(2000).nullish() }),
  z.object({ action: z.literal("sendBack"), note: z.string().min(3).max(2000) }),
  z.object({ action: z.literal("withdraw") }),
  proposeSchema.extend({ action: z.literal("resubmit") }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE, PERMISSIONS.TAX_PARAM_APPROVE]);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "approve":
      return ok(await approveTaxChange(id, actor, body.note));
    case "sendBack":
      return ok(await sendBackTaxChange(id, body.note, actor));
    case "withdraw":
      return ok(await withdrawTaxChange(id, actor));
    case "resubmit":
      return ok(await resubmitTaxChange(id, { kind: body.kind, payload: body.payload, reason: body.reason, legalReference: body.legalReference }, actor));
  }
});
