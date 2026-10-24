/** Pause deliveries over a date window (requirement §31). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { pauseSubscription } from "@/server/services/subscriptions";

// TC-FLD-109: real calendar dates only (422 otherwise).
const schema = z.object({ from: isoDateSchema, until: isoDateSchema });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(
      await pauseSubscription(
        id,
        body.from,
        body.until,
        user,
      ),
    );
  },
);
