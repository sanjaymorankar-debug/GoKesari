/**
 * One subscription plan of a shop (docs/subscription-plans-2026-11).
 *   PUT     replace its settings
 *   PATCH   { isActive } — switch it on or off
 *   DELETE  remove it (running subscribers keep their deliveries until they cancel)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { planInputSchema } from "@/server/api/subscription-plan-schema";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { removePlan, setPlanActive, updatePlan } from "@/server/services/subscription-plans";

export const dynamic = "force-dynamic";

const params = z.object({ id: z.string().uuid(), planId: z.string().uuid() });

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string; planId: string }>) => {
  const { id, planId } = params.parse(await context.params);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, planInputSchema);
  return ok(await updatePlan(id, planId, body, user));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; planId: string }>) => {
  const { id, planId } = params.parse(await context.params);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  const body = await parseBody(request, z.object({ isActive: z.boolean() }));
  return ok(await setPlanActive(id, planId, body.isActive, user));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; planId: string }>) => {
  const { id, planId } = params.parse(await context.params);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
  await removePlan(id, planId, user);
  return noContent();
});
