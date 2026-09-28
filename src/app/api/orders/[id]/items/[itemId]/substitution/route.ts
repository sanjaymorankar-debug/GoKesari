/**
 * Customer decision on a substitute the shop proposed (GS-035).
 * `{ approve: true }` keeps the order going with the substitute (any price
 * difference refunded); `{ approve: false }` removes the item and refunds it.
 * Only the customer who placed the order.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideSubstitution } from "@/server/services/fulfilment";

const schema = z.object({ approve: z.boolean() });

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string; itemId: string }>) => {
    const user = await requirePermission(PERMISSIONS.ORDER_VIEW_OWN);
    const { id, itemId } = await context.params;
    const body = await parseBody(request, schema);
    // decideSubstitution checks the order belongs to this user.
    await decideSubstitution(id, itemId, user, body.approve);
    return ok({ ok: true });
  },
);
