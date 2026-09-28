/** Delivery partner online/offline toggle (delivery-system Part 58, Slice C). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { goOffline, goOnline } from "@/server/services/delivery-partners";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("online"), latitude: z.number(), longitude: z.number() }),
  z.object({ action: z.literal("offline") }),
]);

export const PATCH = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`delivery-status:${user.id}`, RATE_LIMITS.MUTATION);

  const body = await parseBody(request, schema);

  if (body.action === "online") {
    return ok(await goOnline(user.id, body.latitude, body.longitude));
  }
  return ok(await goOffline(user.id));
});
