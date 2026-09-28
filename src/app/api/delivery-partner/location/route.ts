/**
 * Location heartbeat while online (delivery-system Part 58, Slice C).
 * Browser native geolocation only — never a Google Maps Platform call.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateMyLocation } from "@/server/services/delivery-partners";

const schema = z.object({ latitude: z.number(), longitude: z.number() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`delivery-location:${user.id}`, RATE_LIMITS.MUTATION);

  const body = await parseBody(request, schema);
  await updateMyLocation(user.id, body.latitude, body.longitude);
  return noContent();
});
