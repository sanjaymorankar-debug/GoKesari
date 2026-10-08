/** Edit, deactivate or reactivate one of a shop's own delivery people. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateDeliveryStaff } from "@/server/services/fulfilment-options";

const schema = z.object({
  name: z.string().max(80).optional(),
  mobile: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  enforceRateLimit(`delivery-staff:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await updateDeliveryStaff(id, staffId, body, user));
});
