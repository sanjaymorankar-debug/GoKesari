/** Admin/operator confirms a self-declared GSTIN after checking it themselves (no automated provider yet). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adminVerifyGst } from "@/server/services/gst-pan-verification";
import { toShopView } from "@/server/services/shops";

const schema = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  tradeName: z.string().trim().max(200).nullable().optional(),
});

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
    const { id } = await context.params;
    const body = await parseBody(request, schema);
    return ok(toShopView(await adminVerifyGst(id, user, body)));
  },
);
