/**
 * Favourites (docs/search-brand-barcode-favourites-2026-11). Signed in; 404 while the flag
 * brand_barcode_favourites_enabled is off.
 *   GET              → { ids: string[] }  (the hearts, newest first)
 *   GET ?details=1   → { items: FavouriteView[] }  (with the lowest price near the customer)
 *   POST { productId }      → { added, ids }   save one product (saving it again changes nothing)
 *   POST { productIds: [] } → { added, skipped, ids }   a guest's hearts merged at sign-in
 *   DELETE ?productId=…     → { removed, ids }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { requireFeature } from "@/server/services/feature-flags";
import { addFavourite, describeFavourites, listFavouriteIds, MAX_GUEST_MERGE, mergeFavourites, removeFavourite } from "@/server/services/favourites";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

const FLAG = "brand_barcode_favourites_enabled" as const;

const getSchema = z.object({ details: z.enum(["0", "1"]).optional() });

export const GET = route(async (request: NextRequest) => {
  await requireFeature(FLAG);
  const user = await requireUser();
  const { details } = parseQuery(request, getSchema);
  if (details !== "1") return ok({ ids: await listFavouriteIds(user.id) });
  const location = await getCustomerLocation(user.id).catch(() => null);
  const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
  return ok({ items: await describeFavourites({ userId: user.id }, { shopIds: nearby ? [...nearby.keys()] : undefined }) });
});

const postSchema = z.union([
  z.object({ productId: z.string().uuid() }),
  z.object({ productIds: z.array(z.unknown()).max(MAX_GUEST_MERGE * 2) }),
]);

export const POST = route(async (request: NextRequest) => {
  await requireFeature(FLAG);
  const user = await requireUser();
  enforceRateLimit(`favourites:${user.id}`, RATE_LIMITS.FAVOURITES);
  const body = await parseBody(request, postSchema);
  if ("productId" in body) {
    const { added } = await addFavourite(user.id, body.productId);
    return ok({ added, ids: await listFavouriteIds(user.id) });
  }
  return ok(await mergeFavourites(user.id, body.productIds));
});

const deleteSchema = z.object({ productId: z.string().uuid() });

export const DELETE = route(async (request: NextRequest) => {
  await requireFeature(FLAG);
  const user = await requireUser();
  enforceRateLimit(`favourites:${user.id}`, RATE_LIMITS.FAVOURITES);
  const { productId } = parseQuery(request, deleteSchema);
  const { removed } = await removeFavourite(user.id, productId);
  return ok({ removed, ids: await listFavouriteIds(user.id) });
});
