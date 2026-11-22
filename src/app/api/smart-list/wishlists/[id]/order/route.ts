/**
 * "Order from this shop": the wishlist's available items at that shop go into the normal cart (checkout then
 * runs unchanged); missing items are marked "not ordered". Reports changes since the comparison the customer saw.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { orderFromShop } from "@/server/services/smart-list/wishlist";

export const dynamic = "force-dynamic";

const schema = z.object({
  shopId: z.string().uuid(),
  seen: z.record(z.string().uuid(), z.number().int().nonnegative().nullable()).optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`list-order:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const location = await getCustomerLocation(user.id);
  if (!location) throw validationFailed("Set your location first.", { reason: "NO_LOCATION" });
  return ok(await orderFromShop(user.id, (await context.params).id, body.shopId, location, body.seen ?? {}));
});
