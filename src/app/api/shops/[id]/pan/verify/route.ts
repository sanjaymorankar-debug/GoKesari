/** Admin/operator confirms a self-declared PAN after checking it themselves. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adminVerifyPan } from "@/server/services/gst-pan-verification";
import { toShopView } from "@/server/services/shops";

export const POST = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
    const { id } = await context.params;
    return ok(toShopView(await adminVerifyPan(id, user)));
  },
);
