/** Approve a pending shop and assign its classification (§8, §10). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { approveShop, toShopView } from "@/server/services/shops";

const schema = z.object({ classification: z.enum(["KESARI", "GREEN"]) });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_APPROVE);
    const { id } = await context.params;
    const body = await parseBody(request, schema);
    return ok(toShopView(await approveShop(id, body, user)));
  },
);
