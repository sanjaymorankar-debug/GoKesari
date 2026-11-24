/** docs/hdms-2026-11: edit a zone, or suspend / resume it (Super Admin, or Operations for suspend/resume). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryConfig, requireDeliveryOps } from "@/server/delivery/access";
import { zoneSchema } from "@/server/delivery/schemas";
import { saveZone, setZoneSuspended } from "@/server/delivery/zones";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const suspendSchema = z.object({
  action: z.enum(["suspend", "resume"]),
  reason: z.string().trim().min(3).max(200).optional(),
  hours: z.number().int().min(1).max(720).nullable().optional(),
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requireDeliveryConfig();
  const { id } = await context.params;
  const body = await parseBody(request, zoneSchema);
  const zone = await saveZone(id, body, admin.id);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_zone", entityId: id, newValue: body });
  return ok(zone);
});

/** Temporary suspension (rain, festival, strike) is an operations call, not a configuration change. */
export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireDeliveryOps();
  const { id } = await context.params;
  const body = await parseBody(request, suspendSchema);
  const zone = await setZoneSuspended(
    id,
    body.action === "suspend" ? { reason: body.reason ?? "Suspended by operations", until: body.hours ? new Date(Date.now() + body.hours * 3_600_000) : null } : null,
    user.id,
  );
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_zone", entityId: id, newValue: body });
  return ok(zone);
});
