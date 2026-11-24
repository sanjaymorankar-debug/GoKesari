/**
 * docs/guest-checkout-2026-11: moves a signed-in customer's cart lines to the suggested shop. The
 * suggestion is worked out again on the server and must still name `shopId`; each new line is
 * checked for stock like any add. A guest's browser cart is changed in the browser instead.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { featureNotAvailable } from "@/server/services/feature-flags";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { applyRecommendationForUser } from "@/server/guest-checkout/recommendation";
import { isGuestCheckoutOn } from "@/server/guest-checkout/tracking";
import { getCustomerLocation } from "@/server/location";

export const dynamic = "force-dynamic";

const schema = z.object({ shopId: z.string().uuid() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  if (!(await isGuestCheckoutOn())) throw featureNotAvailable("guest_checkout_enabled");
  enforceRateLimit(`cart-recommendation-apply:${user.id}`, RATE_LIMITS.MUTATION);
  const { shopId } = await parseBody(request, schema);
  return ok(await applyRecommendationForUser(user.id, shopId, await getCustomerLocation(user.id)));
});
