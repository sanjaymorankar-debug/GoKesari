/**
 * "Publish to my shop" for an add-by-photo draft: the reviewed fields, the price/stock/unit and the chosen
 * photos. Links the matched master product, or creates a new one through the normal create-product service
 * (pending admin review for a shop owner). 409 with details.reason PRICE_ABOVE_MRP when the price of one pack
 * is above the MRP read from it; 409 for a likely duplicate name (resend with confirmDuplicate).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { publishInputSchema, publishPhotoListing } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), draftId: z.string().uuid() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; draftId: string }>) => {
  const { id, draftId } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`photo-listing-mutate:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, publishInputSchema);
  return ok(await publishPhotoListing(id, user, draftId, body), 201);
});
