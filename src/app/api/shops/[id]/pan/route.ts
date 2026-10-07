/** Shop owner submits a PAN for verification. Encrypted before storage — see gst-pan-verification.ts. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitPan } from "@/server/services/gst-pan-verification";
import { toShopView } from "@/server/services/shops";

const schema = z.object({
  panNumber: z.string().trim().length(10),
  holderName: z.string().trim().min(1).max(200),
});

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
    const { panNumber, holderName } = await parseBody(request, schema);
    return ok(toShopView(await submitPan(id, panNumber, holderName, user)));
  },
);
