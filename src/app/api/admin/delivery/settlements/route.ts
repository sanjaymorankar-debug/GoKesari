/** docs/hdms-2026-11: partner settlements — list (finance) and create for a period (Super Admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { DELIVERY_PROVIDER_CODES } from "@/server/db/hdms-schema";
import { requireDeliveryConfig, requireDeliveryFinanceView } from "@/server/delivery/access";
import { createSettlement, listSettlements } from "@/server/delivery/settlements";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  providerCode: z.enum(DELIVERY_PROVIDER_CODES),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = route(async () => {
  await requireDeliveryFinanceView();
  return ok({ settlements: await listSettlements() });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireDeliveryConfig();
  const body = await parseBody(request, schema);
  const row = await createSettlement(body.providerCode, body.periodStart, body.periodEnd, admin.id);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_settlement", entityId: row.id, newValue: body });
  return ok(row, 201);
});
