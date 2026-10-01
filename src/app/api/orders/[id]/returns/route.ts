/**
 * Request a return for a delivered order (customer only).
 * POST { reason, comment?, items: [{ orderItemId, quantityMilli, condition, comment?, imageIds? }] }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { RETURN_CONDITIONS, RETURN_REASONS } from "@/lib/return-states";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requestReturn } from "@/server/services/returns";

const schema = z.object({
  reason: z.enum(RETURN_REASONS),
  comment: z.string().max(1000).nullish(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantityMilli: z.number().int().positive(),
        condition: z.enum(RETURN_CONDITIONS),
        comment: z.string().max(500).nullish(),
        imageIds: z.array(z.string().uuid()).max(12).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.ORDER_CANCEL_OWN);
  enforceRateLimit(`return-request:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await requestReturn({ orderId: id, ...body }, user), 201);
});
