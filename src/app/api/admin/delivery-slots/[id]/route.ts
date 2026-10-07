/** F5: remove a shop's / area's slot limit (falls back to the area or platform default). */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { deleteSlotCapacity } from "@/server/services/delivery-slots";

export const DELETE = route(async (_request: Request, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const admin = await requireRole("ADMIN");
  await deleteSlotCapacity(id);
  await recordAudit({
    actorId: admin.id,
    actorRole: admin.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "delivery_slot_capacity",
    entityId: id,
    newValue: { deleted: true },
  });
  return ok({ deleted: true });
});
