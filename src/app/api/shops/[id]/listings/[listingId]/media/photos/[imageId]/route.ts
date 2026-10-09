/** Remove one of a shop product's photos (Module 1). If it was the main photo, the next one takes its place. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { deleteListingPhoto } from "@/server/services/shop-media";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), listingId: z.string().uuid(), imageId: z.string().uuid() });

export const DELETE = route(
  async (_request: NextRequest, context: RouteContext<{ id: string; listingId: string; imageId: string }>) => {
    const { id, listingId, imageId } = ids.parse(await context.params);
    const actor = await requireShopCatalogueAccess(id);
    enforceRateLimit(`shop-media:${actor.id}`, RATE_LIMITS.MUTATION);
    await deleteListingPhoto(id, listingId, imageId, actor);
    return noContent();
  },
);
