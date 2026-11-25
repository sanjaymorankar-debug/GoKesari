/** docs/hdms-2026-11: delivery zones — list (operations) and create (Super Admin). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireDeliveryConfig, requireDeliveryOps } from "@/server/delivery/access";
import { zoneSchema } from "@/server/delivery/schemas";
import { listZones, saveZone } from "@/server/delivery/zones";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDeliveryOps();
  return ok({ zones: await listZones() });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireDeliveryConfig();
  const body = await parseBody(request, zoneSchema);
  const zone = await saveZone(null, body, admin.id);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_zone", entityId: zone.id, newValue: body });
  return ok(zone, 201);
});
