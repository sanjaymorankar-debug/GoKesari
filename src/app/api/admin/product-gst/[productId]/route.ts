/**
 * PATCH { hsnCode, gstRatePercent, reason } → sets a master product's own HSN
 * code and GST rate (null clears either). Applies to invoices issued from now
 * on; audited with the reason. Admin only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { productGstSchema, setProductGst } from "@/server/gst/product-rates";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ productId: string }>) => {
  const user = await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  const productId = z.string().uuid().parse((await context.params).productId);
  return ok({ product: await setProductGst(productId, await parseBody(request, productGstSchema), user) });
});
