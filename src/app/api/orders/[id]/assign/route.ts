/**
 * Trigger (or manually retry) delivery assignment for a READY order
 * (delivery-system Part 58, Slice C). A shop owner may only trigger this for
 * their own shop; operator/admin may for any — same ownership pattern as
 * /api/orders/[id]/status.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden, notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import {
  findRiderNow,
  getRiderSearchStatus,
  reassignOrder,
  stopRiderSearch,
  toAssignmentView,
} from "@/server/services/delivery-assignment";

const schema = z.object({
  reassign: z.boolean().optional(),
  /** Stop the automatic search (the shop will deliver the order itself). */
  stop: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const body = await parseBody(request, schema);

    const order = await db.query.orders.findFirst({
      where: eq(orders.id, id),
      columns: { id: true, shopId: true },
    });
    if (!order) throw notFound("Order");

    const { user, isPrivileged } = await requireShopAccess(order.shopId, {
      anyPermission: PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY,
    });
    // A shop owner (non-privileged) may only trigger the initial assignment,
    // not force a manual reassignment away from an already-accepted rider —
    // that override is operator/admin territory.
    if (body.reassign && !isPrivileged) {
      throw forbidden("Only an operator or admin may manually reassign a delivery.");
    }

    if (body.stop) {
      await stopRiderSearch(id, user);
      return ok({ search: await getRiderSearchStatus(id) });
    }
    // "Find rider now": restarts a stopped search and tries immediately; the
    // automatic retries (configurable, see the `dispatch` rule) then continue.
    const result = body.reassign ? await reassignOrder(id, user, body.reason) : await findRiderNow(id, user);
    return ok(toAssignmentView(result));
  },
);

/** Progress of the rider search for an order: state, attempts and the attempt log. */
export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { id: true, shopId: true } });
  if (!order) throw notFound("Order");
  await requireShopAccess(order.shopId, { anyPermission: PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY });
  return ok(await getRiderSearchStatus(id));
});
