/**
 * docs/guest-checkout-2026-11: "Best shop for this cart". A signed-in customer's own cart, or a
 * guest's browser lines (priced the same way as /api/cart/preview), compared across nearby shops
 * that deliver to the chosen location. Reads only. 404 unless both guest flags are on.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { featureNotAvailable } from "@/server/services/feature-flags";
import { GUEST_CART_MAX_LINES } from "@/lib/guest-cart";
import { MAX_CART_LINE_QUANTITY } from "@/lib/stock-quantity";
import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { linesFromSummary, recommendForUserCart, recommendShopForCart } from "@/server/guest-checkout/recommendation";
import { isGuestCheckoutOn } from "@/server/guest-checkout/tracking";
import { getCustomerLocation } from "@/server/location";
import { previewGuestCart } from "@/server/services/guest-cart";

export const dynamic = "force-dynamic";

const schema = z.object({
  lines: z
    .array(z.object({ shopProductId: z.string().uuid(), quantity: z.number().positive().max(MAX_CART_LINE_QUANTITY) }))
    .max(GUEST_CART_MAX_LINES)
    .optional(),
});

export const POST = route(async (request: NextRequest) => {
  if (!(await isGuestCheckoutOn())) throw featureNotAvailable("guest_checkout_enabled");
  const user = await getCurrentUser();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  enforceRateLimit(`cart-recommendation:${user?.id ?? ip}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  // A guest asks about the lines in their browser: with none there is nothing to compare (TC-SEC-001).
  if (!user && !body.lines?.length) throw validationFailed("Add something to your cart first.");
  const location = await getCustomerLocation(user?.id ?? null);
  if (user) return ok({ recommendation: await recommendForUserCart(user.id, location) });
  const preview = await previewGuestCart(body.lines ?? []);
  return ok({ recommendation: await recommendShopForCart(linesFromSummary(preview), preview.grandTotalPaise, location) });
});
