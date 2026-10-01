/**
 * Re-checks the cart against a delivery location.
 *
 * GET  ?addressId=<uuid>   — validate against a saved address; without it the
 *                            customer's chosen location (cookie / default
 *                            address) is used
 * DELETE ?shopId=<uuid>    — the "this shop cannot deliver here" resolution:
 *                            drop that shop's lines from the cart
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getCustomerLocation, locationFromAddress } from "@/server/location";
import { getAddress } from "@/server/services/addresses";
import { removeShopFromCart, validateCartForLocation } from "@/server/services/cart-validation";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const { addressId } = parseQuery(request, z.object({ addressId: z.string().uuid().optional() }));
  const location = addressId
    ? locationFromAddress(await getAddress(user.id, addressId))
    : await getCustomerLocation(user.id);
  return ok(await validateCartForLocation(user.id, location));
});

export const DELETE = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = new URL(request.url).searchParams.get("shopId");
  if (!shopId || !z.string().uuid().safeParse(shopId).success) throw validationFailed("shopId is required.");
  await removeShopFromCart(user.id, shopId);
  return ok({ removed: true });
});
