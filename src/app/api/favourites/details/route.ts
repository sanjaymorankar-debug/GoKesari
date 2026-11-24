/**
 * A guest's favourites (docs/search-brand-barcode-favourites-2026-11): their hearts live in the
 * browser; /favourites asks here for what those products cost now. Public catalogue data only —
 * nothing is stored. 404 while the flag brand_barcode_favourites_enabled is off.
 *   GET ?ids=<uuid>,<uuid>,… (at most 100) → { items: FavouriteView[] }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { requireFeature } from "@/server/services/feature-flags";
import { describeFavourites, MAX_GUEST_MERGE } from "@/server/services/favourites";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

const querySchema = z.object({ ids: z.string().max(40 * MAX_GUEST_MERGE).default("") });

export const GET = route(async (request: NextRequest) => {
  await requireFeature("brand_barcode_favourites_enabled");
  const user = await getCurrentUser();
  enforceRateLimit(user ? `favourites-details:${user.id}` : clientKey(request, "favourites-details"), RATE_LIMITS.SEARCH_SUGGEST);
  const { ids } = parseQuery(request, querySchema);
  const productIds = ids.split(",").map((s) => s.trim()).filter(Boolean);
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
  return ok({ items: await describeFavourites({ productIds }, { shopIds: nearby ? [...nearby.keys()] : undefined }) });
});
