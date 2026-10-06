/** F8: edit a shop offer, or end it early with active: false (owner only). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { saveShopOffer } from "@/server/services/shop-offers";
import { shopOfferSchema } from "../schema";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string; offerId: string }>) => {
  const { id, offerId } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  return ok(await saveShopOffer(id, await parseBody(request, shopOfferSchema), user, offerId));
});
