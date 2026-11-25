/** docs/hdms-2026-11: verify or reject a shop rider's ID proof (Super Admin; audited). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryConfig } from "@/server/delivery/access";
import { decideShopRiderKyc } from "@/server/delivery/admin";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({ verified: z.boolean() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requireDeliveryConfig();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const row = await decideShopRiderKyc(id, body.verified);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "shop_delivery_staff", entityId: id, newValue: { kycStatus: row.kycStatus } });
  return ok({ id: row.id, kycStatus: row.kycStatus });
});
