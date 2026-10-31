/**
 * Gig worker flow (feature 7): the delivery partners who carried this shop's
 * orders, each with the counts and lists of societies that authorise and
 * block them. Partners whose identity is hidden from the shop (feature 8)
 * are not listed. Shop owner of this shop (or an admin) only.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listShopDeliveryPartners } from "@/server/services/society-partner-access";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok({ partners: await listShopDeliveryPartners(id, user) });
});
