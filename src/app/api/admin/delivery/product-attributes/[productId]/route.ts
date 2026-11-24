/** docs/hdms-2026-11: a product's delivery attributes (perishable, fragile, chilled, weight, size, max minutes). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveProductDeliveryAttributes } from "@/server/delivery/admin";
import { productDeliverySchema } from "@/server/delivery/schemas";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ productId: string }>) => {
  const user = await requirePermission(PERMISSIONS.PRODUCT_MANAGE);
  const { productId } = await context.params;
  const body = await parseBody(request, productDeliverySchema);
  const row = await saveProductDeliveryAttributes(productId, body, user.id);
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "product_delivery_attributes", entityId: productId, newValue: body });
  return ok(row);
});
