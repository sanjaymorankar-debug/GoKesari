/** Reorder a shop product's photos (Module 1). PUT { imageIds: [...] } — every photo once; the first is the main photo. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { reorderListingPhotos } from "@/server/services/shop-media";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), listingId: z.string().uuid() });
const schema = z.object({ imageIds: z.array(z.string().uuid()).min(1).max(20) });

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string; listingId: string }>) => {
  const { id, listingId } = ids.parse(await context.params);
  const actor = await requireShopCatalogueAccess(id);
  enforceRateLimit(`shop-media:${actor.id}`, RATE_LIMITS.MUTATION);
  const { imageIds } = await parseBody(request, schema);
  await reorderListingPhotos(id, listingId, imageIds, actor);
  return noContent();
});
