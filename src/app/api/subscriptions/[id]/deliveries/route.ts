/** SM-004: each delivery of a subscription with its own status. */
import type { NextRequest } from "next/server";

import { addDays, assertIsoDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listDeliveriesForSubscription } from "@/server/services/subscription-schedule";

export const dynamic = "force-dynamic";

export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    const params = new URL(request.url).searchParams;
    const from = params.get("from") ? assertIsoDate(params.get("from")!) : addDays(todayIn(getEnv().APP_TIMEZONE), -14);
    const days = Math.min(Math.max(Number(params.get("days") ?? 30), 1), 120);
    return ok(await listDeliveriesForSubscription(id, { from, until: addDays(from, days) }));
  },
);
