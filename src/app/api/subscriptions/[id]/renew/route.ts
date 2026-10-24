/**
 * SM-004: renew a subscription whose renewal is due — a later end date (or
 * none) for TERM_END; for PAYMENT_DUE it succeeds once the wallet covers the
 * next deliveries.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { renewSubscription } from "@/server/services/subscription-renewal";

/** endDate: a new end date; null = no end date; omitted = extend by the same term length. */
const schema = z.object({ endDate: isoDateSchema.nullish() }); // TC-FLD-109

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, {
      anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(await renewSubscription(id, { endDate: body.endDate }, user));
  },
);
