/** F8: a shop's own offers. GET lists them; POST creates one (owner only). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { listShopOffers, saveShopOffer } from "@/server/services/shop-offers";
import { shopOfferSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopMarketing(id, "view");
  return ok({ offers: await listShopOffers(id) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  return ok(await saveShopOffer(id, await parseBody(request, shopOfferSchema), user), 201);
});
