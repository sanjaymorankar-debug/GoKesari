/**
 * A shop product's own photos and descriptions (Module 1, docs/three-modules-2026-10).
 *   GET    → photos (main first), descriptions, the master product's photos and
 *            description, what customers see now, and the limits.
 *   PATCH  { shortDescription?, longDescription? } — null or "" clears it
 *            (customers then see the master product's description).
 * The shop's owner, its staff (shop_staff) and operators/admins only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { getListingMedia, updateListingDescriptions } from "@/server/services/shop-media";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

type Params = { id: string; listingId: string };

const ids = z.object({ id: z.string().uuid(), listingId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<Params>) => {
  const { id, listingId } = ids.parse(await context.params);
  await requireShopCatalogueAccess(id);
  return ok(await getListingMedia(id, listingId));
});

const patchSchema = z
  .object({
    shortDescription: z.string().max(20_000).nullable().optional(),
    longDescription: z.string().max(50_000).nullable().optional(),
  })
  .refine((v) => v.shortDescription !== undefined || v.longDescription !== undefined, "Nothing to change.");

export const PATCH = route(async (request: NextRequest, context: RouteContext<Params>) => {
  const { id, listingId } = ids.parse(await context.params);
  const actor = await requireShopCatalogueAccess(id);
  enforceRateLimit(`shop-media:${actor.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, patchSchema);
  return ok(await updateListingDescriptions(id, listingId, body, actor));
});
