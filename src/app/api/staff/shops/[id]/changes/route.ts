/**
 * RBAC v2 Phase 5: Support proposes changes to a shop (the shop owner approves item by item). GET lists the
 * shop's pending (and with ?history=1 past) change requests.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listShopChangeRequests, PRODUCT_FIELDS, proposeShopChanges, SHOP_FIELDS } from "@/server/rbac-support/change-requests";

export const dynamic = "force-dynamic";

const item = z.discriminatedUnion("target", [
  z.object({ target: z.literal("SHOP"), field: z.enum(SHOP_FIELDS), value: z.string().max(2000).nullable() }),
  z.object({ target: z.literal("SHOP_PRODUCT"), shopProductId: z.string().uuid(), field: z.enum(PRODUCT_FIELDS), value: z.union([z.string().max(2000), z.number(), z.boolean()]).nullable() }),
  z.object({ target: z.literal("ADD_PRODUCT"), productId: z.string().uuid(), onlinePricePaise: z.number().int().positive().nullable(), offlinePricePaise: z.number().int().positive().nullable() }),
]);
const schema = z.object({ ticketId: z.string().uuid().nullish(), reason: z.string().trim().min(3).max(1000), items: z.array(item).min(1).max(2000) });

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.SHOP_CHANGE_PROPOSE, PERMISSIONS.SUPPORT_QUEUE_MANAGE, PERMISSIONS.SHOP_CHANGE_DECIDE_OWN]);
  const { id } = await context.params;
  const { history } = parseQuery(request, z.object({ history: z.enum(["0", "1"]).default("0") }));
  return ok(await listShopChangeRequests(id, actor, { history: history === "1" }));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.SHOP_CHANGE_PROPOSE]);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await proposeShopChanges({ shopId: id, ticketId: body.ticketId, reason: body.reason, items: body.items }, actor), 201);
});
