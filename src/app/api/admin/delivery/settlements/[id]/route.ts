/** docs/hdms-2026-11: reconcile a settlement with the partner's invoice (CSV) or mark it paid (Super Admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryConfig, requireDeliveryFinanceView } from "@/server/delivery/access";
import { markSettlementPaid, reconcileSettlement, settlementLines } from "@/server/delivery/settlements";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reconcile"), invoiceCsv: z.string().min(3).max(500_000), invoiceRef: z.string().max(100).nullable().optional() }),
  z.object({ action: z.literal("paid"), paidRef: z.string().trim().min(3).max(100) }),
]);

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDeliveryFinanceView();
  const { id } = await context.params;
  return ok({ lines: await settlementLines(id) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requireDeliveryConfig();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const row = body.action === "reconcile" ? await reconcileSettlement(id, body.invoiceCsv, body.invoiceRef ?? null) : await markSettlementPaid(id, body.paidRef);
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_settlement", entityId: id, newValue: { action: body.action, status: row.status } });
  return ok(row);
});
