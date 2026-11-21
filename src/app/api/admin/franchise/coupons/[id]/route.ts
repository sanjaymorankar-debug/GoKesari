/**
 * Admin, one coupon (§5.7):
 *   PUT    full coupon (as POST)          edit
 *   PATCH  { action: "pause" | "resume" }
 *   PATCH  { action: "assign", dealers: [{ dealerId? | mobileE164? | email? }] }
 *   DELETE ?assignment=<id>               remove one assignment
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { couponInputSchema } from "@/server/franchise/coupon-schema";
import { assignCoupon, removeAssignment, setCouponPaused, updateCoupon } from "@/server/franchise/coupons";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  return ok({ coupon: await updateCoupon((await params).id, await parseBody(request, couponInputSchema), actor) });
});

const patch = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume"]) }),
  z.object({ action: z.literal("assign"), dealers: z.array(z.object({ dealerId: z.string().uuid().optional(), mobileE164: z.string().regex(/^\+91[6-9][0-9]{9}$/).optional(), email: z.string().email().optional() })).min(1).max(500) }),
]);

export const PATCH = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  const id = (await params).id;
  const b = await parseBody(request, patch);
  if (b.action === "assign") return ok({ assigned: await assignCoupon(id, b.dealers, actor) });
  await setCouponPaused(id, b.action === "pause", actor);
  return ok({ id, status: b.action === "pause" ? "PAUSED" : "ACTIVE" });
});

export const DELETE = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const q = parseQuery(request, z.object({ assignment: z.string().uuid() }));
  await removeAssignment(q.assignment, actor);
  return ok({ removed: q.assignment });
});
