/** Skip one delivery — no order, no deduction (requirement §30). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { skipDate } from "@/server/services/subscriptions";

// TC-FLD-109: "", "next friday" or 31 February → 422, never a 500.
const schema = z.object({ date: isoDateSchema });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(await skipDate(id, body.date, user));
  },
);
