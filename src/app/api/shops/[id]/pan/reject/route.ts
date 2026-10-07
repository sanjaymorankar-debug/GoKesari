/** Admin/operator rejects a self-declared PAN that didn't check out. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adminRejectPan } from "@/server/services/gst-pan-verification";
import { toShopView } from "@/server/services/shops";

const schema = z.object({ reason: z.string().min(3).max(500) });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
    const { id } = await context.params;
    const { reason } = await parseBody(request, schema);
    return ok(toShopView(await adminRejectPan(id, reason, user)));
  },
);
