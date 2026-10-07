/**
 * F5: per-shop / per-area delivery slot limits (admin only; audited).
 * GET → every limit. PUT { shopId | pincode, expressPerHour, standardPerHour, scheduledPerDay } → create or replace.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { listSlotCapacities, upsertSlotCapacity } from "@/server/services/delivery-slots";

export const dynamic = "force-dynamic";

const limit = z.number().int().min(0).max(100_000).nullable();
const schema = z.object({
  shopId: z.string().uuid().nullable().optional(),
  pincode: z.string().max(6).nullable().optional(),
  expressPerHour: limit,
  standardPerHour: limit,
  scheduledPerDay: limit,
  /** GS-027: per chosen time slot. Optional so older clients keep working. */
  scheduledPerSlot: limit.optional(),
});

export const GET = route(async () => {
  await requireRole("ADMIN");
  return ok({ capacities: await listSlotCapacities() });
});

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  const row = await upsertSlotCapacity(body, admin.id);
  await recordAudit({
    actorId: admin.id,
    actorRole: admin.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "delivery_slot_capacity",
    entityId: row.id,
    newValue: body,
  });
  return ok(row);
});
