/** Many GSTINs per shop: DELETE removes an extra GSTIN (owner, or staff who may verify GST/PAN). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { removeShopGstRegistration } from "@/server/services/shop-gst-registrations";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; registrationId: string }>) => {
  const { id, registrationId } = await context.params;
  const { user, isPrivileged } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  return ok(await removeShopGstRegistration({ shopId: id, registrationId, actor: user, privileged: isPrivileged }));
});
