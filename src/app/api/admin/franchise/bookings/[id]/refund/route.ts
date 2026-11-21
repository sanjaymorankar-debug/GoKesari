/** Admin: POST { reason } — a franchise booking fully refunded (§5.7): franchises voided, codes closed, coupon use released. Refund the money in the gateway. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { refundBooking } from "@/server/franchise/booking";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ reason: z.string().trim().min(5).max(300) }));
  await refundBooking((await params).id, b.reason, actor);
  return ok({ refunded: (await params).id });
});
