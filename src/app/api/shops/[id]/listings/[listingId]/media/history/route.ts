/** Who changed a shop product's photos and descriptions, and when (Module 1), newest first. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { listingHistory } from "@/server/services/shop-media";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), listingId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; listingId: string }>) => {
  const { id, listingId } = ids.parse(await context.params);
  await requireShopCatalogueAccess(id);
  return ok({ changes: await listingHistory(id, listingId) });
});
