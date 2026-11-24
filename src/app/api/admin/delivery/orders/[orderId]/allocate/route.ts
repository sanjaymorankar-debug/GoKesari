/** docs/hdms-2026-11: run the allocation engine for a ready order now (Operations; audited). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryOps } from "@/server/delivery/access";
import { allocateOrder } from "@/server/delivery/allocation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({ partnersOnly: z.boolean().optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ orderId: string }>) => {
  const user = await requireDeliveryOps();
  const { orderId } = await context.params;
  z.string().uuid().parse(orderId);
  const body = await parseBody(request, schema);
  const result = await allocateOrder(orderId, "MANUAL_ADMIN", { actorId: user.id, externalOnly: body.partnersOnly });
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_allocation", entityId: orderId, newValue: { outcome: result.outcome, provider: result.providerCode, detail: result.detail } });
  return ok({ outcome: result.outcome, channel: result.channel, providerCode: result.providerCode, bookingId: result.booking?.id ?? null, detail: result.detail, candidates: result.candidates });
});
