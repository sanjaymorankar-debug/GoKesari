/**
 * What would one delivery earn under the current slots and incentives?
 * Read-only: nothing is written. `at` defaults to now.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { previewEarning } from "@/server/services/delivery-earnings";

const schema = z.object({
  outcome: z.enum(["DELIVERED", "FAILED", "CANCELLED_AFTER_PICKUP"]).optional(),
  distanceKm: z.number().min(0).max(200),
  orderSubtotalPaise: z.number().int().min(0),
  at: z.string().datetime().optional(),
  dayCount: z.number().int().min(1).optional(),
  weekCount: z.number().int().min(1).optional(),
  minutesLate: z.number().min(0).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await previewEarning({ ...body, at: body.at ? new Date(body.at) : new Date() }));
});
