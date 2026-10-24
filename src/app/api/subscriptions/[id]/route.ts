/** Read, modify permanently, or cancel one subscription (§32). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireSubscriptionAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  cancelSubscription,
  getSubscriptionDetail,
  updateSubscription,
} from "@/server/services/subscriptions";

const ACCESS = { anyPermission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY } as const;

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    await requireSubscriptionAccess(id, ACCESS);

    const detail = await getSubscriptionDetail(id);
    if (!detail) throw notFound("Subscription");
    return ok(detail);
  },
);

const patchSchema = z.object({
  quantityMilli: z.number().int().positive().max(100_000).optional(),
  shopProductId: z.string().uuid().optional(),
  frequency: z.enum(["DAILY", "WEEKLY"]).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  addressId: z.string().uuid().nullish(),
  // TC-FLD-109: real calendar dates only (422 otherwise, never a 500).
  endDate: isoDateSchema.nullish(),
  effectiveFrom: isoDateSchema.optional(),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, ACCESS);
    const body = await parseBody(request, patchSchema);

    return ok(
      await updateSubscription(
        id,
        body,
        user,
      ),
    );
  },
);

const cancelSchema = z.object({ reason: z.string().max(300).default("") });

export const DELETE = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireSubscriptionAccess(id, ACCESS);
    const body = await parseBody(request, cancelSchema).catch(() => ({
      reason: "",
    }));
    return ok(await cancelSubscription(id, body.reason, user));
  },
);
