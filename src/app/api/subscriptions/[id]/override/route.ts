/**
 * Per-date quantity override (requirement §28) — the "3 L tomorrow" control.
 * DELETE restores the standing quantity for that date.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { clearOverride, setDailyOverride } from "@/server/services/subscriptions";

const ACCESS = { anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY } as const;

// TC-FLD-109: real calendar dates only (422 otherwise).
const schema = z.object({
  date: isoDateSchema,
  quantityMilli: z.number().int().positive().max(100_000),
});

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, ACCESS);
    const body = await parseBody(request, schema);
    return ok(
      await setDailyOverride(
        id,
        body.date,
        body.quantityMilli,
        user,
      ),
    );
  },
);

const clearSchema = z.object({ date: isoDateSchema });

export const DELETE = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    await requireSubscriptionAccess(id, ACCESS);
    const body = await parseBody(request, clearSchema);
    await clearOverride(id, body.date);
    return ok({ cleared: true });
  },
);
