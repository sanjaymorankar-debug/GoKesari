/** Edit a registration-fee coupon (including switching it off with active: false). Admin only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveRegistrationFeeCoupon } from "@/server/services/registration-fee-coupons";
import { registrationFeeCouponSchema } from "../schema";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const admin = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  return ok(await saveRegistrationFeeCoupon(await parseBody(request, registrationFeeCouponSchema), admin, id));
});
