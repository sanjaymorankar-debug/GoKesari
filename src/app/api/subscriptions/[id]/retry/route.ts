/** Retry a delivery that failed for insufficient balance (requirement §39). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { retryFailedDelivery } from "@/server/services/subscriptions";

const schema = z.object({ date: isoDateSchema }); // TC-FLD-109

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    const body = await parseBody(request, schema);
    const outcome = await retryFailedDelivery(id, body.date);
    return ok({ outcome });
  },
);
