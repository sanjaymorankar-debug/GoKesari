/**
 * F7: check a coupon code against the customer's current cart and preview the
 * discount. Checkout re-validates it; this never reserves anything.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getCart } from "@/server/services/cart";
import { quoteCoupon } from "@/server/services/coupons";

const schema = z.object({ code: z.string().trim().min(1).max(32), requestId: z.string().min(8).max(64) });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  enforceRateLimit(`coupon-check:${user.id}`, RATE_LIMITS.MUTATION);
  const { code, requestId } = await parseBody(request, schema);
  const cart = await getCart(user.id);
  const groups = cart.groups
    .filter((g) => g.lines.some((l) => l.purchasable))
    .map((g) => ({ shopId: g.shop.id, goodsPaise: g.subtotalPaise }));
  return ok(await quoteCoupon(code, user.id, requestId, groups));
});
