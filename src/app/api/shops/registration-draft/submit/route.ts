/**
 * Onboarding wizard: POST "Create my shop and pay". The shop is created from
 * the owner's draft and its government checks are copied to the shop's seller
 * verifications; the answer is the wizard at its payment step (the payment
 * itself is POST /api/shops/[id]/registration-fee, as for Add my shop).
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitDraftForPayment } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(
    await submitDraftForPayment({
      actor: user,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
