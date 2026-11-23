/**
 * Admin / Finance: POST { reason } — a franchise booking fully refunded (§5.7): franchises voided, codes closed, coupon
 * use released. Refund the money in the gateway. docs/dealer-platform phase 6: DEALER_REFUND permission; with
 * dealer_platform_four_eye on, a second admin approves first (answers 202).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { dealerFourEyeOn, requestDealerApproval } from "@/server/approvals";
import { requireDealerPermission } from "@/server/dealers/staff-access";
import { refundBooking } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const actor = { id: user.id, role: user.role };
  requireDealerPermission(actor, PERMISSIONS.DEALER_REFUND, "refund franchise bookings");
  const b = await parseBody(request, z.object({ reason: z.string().trim().min(5).max(300) }));
  const id = (await params).id;
  if (await dealerFourEyeOn()) return ok(await requestDealerApproval({ type: "FRANCHISE_REFUND", actor, subjectType: "franchise_booking", subjectId: id, title: "Refund a franchise booking", reason: b.reason, payload: { bookingId: id } }), 202);
  await refundBooking(id, b.reason, actor);
  return ok({ refunded: id });
});
