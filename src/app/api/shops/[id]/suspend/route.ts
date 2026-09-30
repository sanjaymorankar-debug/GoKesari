/**
 * Suspend an approved shop (SHOP_SUSPEND — operator, admin).
 *   GET  → impact preview: what the suspension policy would do to each open order
 *   POST { reason, expectedAction? } → suspend; open orders are judged by status
 *          (cancel + refund / let continue / hold for review), the owner is
 *          notified, and the impact is returned
 * Existing callers that send only { reason } keep working.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { previewSuspension, suspendShopWithPolicy } from "@/server/services/shop-suspension";

export const dynamic = "force-dynamic";

const schema = z.object({
  reason: z.string().trim().min(3).max(500),
  expectedAction: z.string().trim().min(3).max(300).nullish(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.SHOP_SUSPEND);
  const { id } = await context.params;
  return ok(await previewSuspension(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_SUSPEND);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const result = await suspendShopWithPolicy(id, body, user);
  return ok({ id: result.shop.id, status: result.shop.status, impact: result.impact });
});
