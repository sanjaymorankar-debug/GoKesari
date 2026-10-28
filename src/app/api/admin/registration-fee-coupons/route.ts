/** Registration-fee coupons (owner, 27 Oct 2026; admin only, audited). GET → all with use counts. POST → create. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRegistrationFeeCoupons, saveRegistrationFeeCoupon } from "@/server/services/registration-fee-coupons";
import { registrationFeeCouponSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  return ok({ coupons: await listRegistrationFeeCoupons() });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  return ok(await saveRegistrationFeeCoupon(await parseBody(request, registrationFeeCouponSchema), admin), 201);
});
