/** docs/hdms-2026-11: edit a delivery pricing rule (Super Admin; audited). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryConfig } from "@/server/delivery/access";
import { savePricingRule } from "@/server/delivery/admin";
import { pricingRuleSchema } from "@/server/delivery/schemas";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requireDeliveryConfig();
  const { id } = await context.params;
  const body = await parseBody(request, pricingRuleSchema);
  const row = await savePricingRule(id, body, admin.id);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_pricing_rule", entityId: id, newValue: body });
  return ok(row);
});
