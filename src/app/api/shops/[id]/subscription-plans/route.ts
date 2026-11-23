/**
 * A shop's subscription plans (docs/subscription-plans-2026-11).
 *   GET   the shop's plans with their subscriber counts
 *   POST  a new plan (owner of this shop, or staff with shop-product:manage:any)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { planInputSchema } from "@/server/api/subscription-plan-schema";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createPlan, listShopPlans } from "@/server/services/subscription-plans";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  z.string().uuid().parse(id);
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  return ok(await listShopPlans(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, planInputSchema);
  return ok(await createPlan(id, body, user), 201);
});
