/**
 * A shop's own delivery people (docs/four-features-2026-10, feature 1).
 * The shop's owner, or staff with SHOP_UPDATE_ANY.
 *   GET   → every delivery person (active first)
 *   POST  { name, mobile } → add one
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addDeliveryStaff, listDeliveryStaff } from "@/server/services/fulfilment-options";

export const dynamic = "force-dynamic";

const schema = z.object({ name: z.string().max(80), mobile: z.string().max(20) });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  return ok({ staff: await listDeliveryStaff(id) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  enforceRateLimit(`delivery-staff:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await addDeliveryStaff(id, body, user), 201);
});
