/**
 * Delivery partner availability toggle (delivery-system Part 58, Slice C;
 * gig worker flow feature 5): Offline / Active / Ready. "online" is the
 * older name for Ready, kept for app builds that still send it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { goOffline, goOnline } from "@/server/services/delivery-partners";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("online"), latitude: z.number(), longitude: z.number() }),
  z.object({ action: z.literal("ready"), latitude: z.number(), longitude: z.number() }),
  z.object({ action: z.literal("active"), latitude: z.number(), longitude: z.number() }),
  z.object({ action: z.literal("offline") }),
]);

export const PATCH = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`delivery-status:${user.id}`, RATE_LIMITS.MUTATION);

  const body = await parseBody(request, schema);

  if (body.action !== "offline") {
    return ok(await goOnline(user.id, body.latitude, body.longitude, body.action === "active" ? "ACTIVE" : "READY"));
  }
  return ok(await goOffline(user.id));
});
