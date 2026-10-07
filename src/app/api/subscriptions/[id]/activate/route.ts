/** SM-004: start a DRAFT subscription. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { activateSubscription } from "@/server/services/subscriptions";

export const POST = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    return ok(await activateSubscription(id, user));
  },
);
