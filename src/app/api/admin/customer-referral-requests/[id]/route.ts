/**
 * Operations answer a customer's request for a referral code. REFERRAL_MANAGE.
 *   { action: "issue", code?, note? }   creates the referral code (typed, or generated) and tells the customer
 *   { action: "reject", reason }
 *   { action: "resend_email" }          sends the referrals email again
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  issueCodeForCustomerRequest,
  rejectCustomerReferralRequest,
  resendCustomerReferralRequestEmail,
} from "@/server/services/customer-referral-requests";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), code: z.string().max(32).nullish(), note: z.string().max(300).nullish() }),
  z.object({ action: z.literal("reject"), reason: z.string().max(300) }),
  z.object({ action: z.literal("resend_email") }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "issue":
      return ok(await issueCodeForCustomerRequest(id, body, user));
    case "reject":
      return ok(await rejectCustomerReferralRequest(id, body.reason, user));
    case "resend_email":
      return ok(await resendCustomerReferralRequestEmail(id, user));
  }
});
