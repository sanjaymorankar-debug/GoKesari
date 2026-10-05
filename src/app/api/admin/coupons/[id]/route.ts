/** F7: edit a coupon (including switching it off with active: false). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { saveCoupon } from "@/server/services/coupons";
import { couponSchema } from "../schema";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const admin = await requireRole("ADMIN");
  return ok(await saveCoupon(await parseBody(request, couponSchema), admin, id));
});
