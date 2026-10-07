/**
 * Change Kesari/Green (requirement §10).
 *
 * Guarded by SHOP_SET_CLASSIFICATION, which SHOP_OWNER does not hold — and the
 * service refuses the role a second time as defence in depth.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { changeClassification, getClassificationHistory, toShopView } from "@/server/services/shops";

const schema = z.object({
  classification: z.enum(["KESARI", "GREEN"]),
  reason: z.string().min(3).max(500),
});

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    await requirePermission(PERMISSIONS.SHOP_SET_CLASSIFICATION);
    const { id } = await context.params;
    return ok(await getClassificationHistory(id));
  },
);

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_SET_CLASSIFICATION);
    const { id } = await context.params;
    const body = await parseBody(request, schema);
    return ok(toShopView(await changeClassification(id, body.classification, body.reason, user)));
  },
);
