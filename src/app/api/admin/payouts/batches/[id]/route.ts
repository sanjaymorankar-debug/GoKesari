/**
 * A payout batch (batch-2026-10 WS-E): GET (PAYOUT_VIEW); PATCH approve
 * (PAYOUT_APPROVE, maker-checker), execute through the provider or cancel
 * (PAYOUT_MANAGE).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { approvePayoutBatch, cancelPayoutBatch, executePayoutBatch, getPayoutBatch } from "@/server/payouts/batches";
import { isUuid } from "@/server/payouts/http";

const schema = z.object({ action: z.enum(["approve", "execute", "cancel"]), note: z.string().max(300).optional() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.PAYOUT_VIEW);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payout batch");
  return ok(await getPayoutBatch(id));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payout batch");
  const body = await parseBody(request, schema);
  if (body.action === "approve") {
    const user = await requirePermission(PERMISSIONS.PAYOUT_APPROVE);
    return ok(await approvePayoutBatch(id, user));
  }
  const user = await requirePermission(PERMISSIONS.PAYOUT_MANAGE);
  if (body.action === "execute") return ok(await executePayoutBatch(id, user));
  return ok(await cancelPayoutBatch(id, user, body.note ?? ""));
});
