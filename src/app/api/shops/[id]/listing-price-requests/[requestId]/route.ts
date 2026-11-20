/**
 * The shop answers a price request: POST { pricePaise } sets the listing's price and puts it on
 * sale (every waiting customer is told), or { decline: true }.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { paise } from "@/server/puja/route-helpers";
import { answerPriceRequest } from "@/server/puja/storefront";

export const dynamic = "force-dynamic";

const schema = z.object({ pricePaise: paise.optional(), decline: z.boolean().optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; requestId: string }>) => {
  const { id, requestId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, schema);
  return ok(await answerPriceRequest(id, requestId, body, user));
});
