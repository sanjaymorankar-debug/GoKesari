/** Compare a wishlist's prices across nearby shops (radius: rule smartShopping.comparisonRadiusKm). Writes nothing. */
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { compareSavedWishlist } from "@/server/services/smart-list/wishlist";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`list-compare:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  const { pending } = parseQuery(request, z.object({ pending: z.enum(["0", "1"]).optional() }));
  const location = await getCustomerLocation(user.id);
  if (!location) throw validationFailed("Set your location first, so we can find shops near you.", { reason: "NO_LOCATION" });
  return ok(await compareSavedWishlist(user.id, (await context.params).id, location, pending === "1"));
});
