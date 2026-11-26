/**
 * docs/guest-cart-2026-11: after sign-in, moves the guest's browser cart into
 * the account cart (quantities added, capped at stock and the line maximum;
 * unavailable lines dropped and named). 404 while guest_cart_enabled is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { GUEST_CART_MAX_LINES } from "@/lib/guest-cart";
import { MAX_CART_LINE_QUANTITY } from "@/lib/stock-quantity";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireGuestCart } from "@/server/onboarding-v2/customer";
import { mergeGuestCart } from "@/server/services/guest-cart";

export const dynamic = "force-dynamic";

const schema = z.object({
  lines: z
    .array(z.object({ shopProductId: z.string().uuid(), quantity: z.number().positive().max(MAX_CART_LINE_QUANTITY) }))
    .max(GUEST_CART_MAX_LINES),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  // docs/onboarding-v2-2026-11: onboarding_v2 implies the guest cart.
  await requireGuestCart();
  const { lines } = await parseBody(request, schema);
  return ok(await mergeGuestCart(user.id, lines));
});
