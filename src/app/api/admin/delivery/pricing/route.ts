/** docs/hdms-2026-11: delivery pricing rules — list and create (Super Admin; audited). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireDeliveryConfig, requireDeliveryOps } from "@/server/delivery/access";
import { listPricingRules, savePricingRule } from "@/server/delivery/admin";
import { pricingRuleSchema } from "@/server/delivery/schemas";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDeliveryOps();
  return ok({ rules: await listPricingRules() });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireDeliveryConfig();
  const body = await parseBody(request, pricingRuleSchema);
  const row = await savePricingRule(null, body, admin.id);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_pricing_rule", entityId: row.id, newValue: body });
  return ok(row, 201);
});
