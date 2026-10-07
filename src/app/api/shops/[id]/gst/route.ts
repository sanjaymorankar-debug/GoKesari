/** Shop owner submits (or declares absence of) a GSTIN for verification. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { setGstNotRegistered, submitGstin } from "@/server/services/gst-pan-verification";
import { toShopView } from "@/server/services/shops";

const schema = z.union([
  z.object({ gstin: z.string().trim().length(15) }),
  z.object({ notRegistered: z.literal(true) }),
]);

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
    const body = await parseBody(request, schema);

    if ("notRegistered" in body) {
      return ok(toShopView(await setGstNotRegistered(id, user)));
    }
    return ok(toShopView(await submitGstin(id, body.gstin, user)));
  },
);
