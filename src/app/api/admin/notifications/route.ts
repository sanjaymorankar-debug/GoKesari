/**
 * Outbound notification deliveries for operations: counts, the log (failures
 * first if filtered), and re-queueing a dead or skipped delivery.
 *   GET ?status=DEAD|FAILED|SKIPPED|SENT|PENDING
 *   POST { id } → put one back in the queue
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getDeliveryStats, listDeliveries, requeueDelivery } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

const STATUSES = ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED", "DEAD"] as const;

export const GET = route(async (request: NextRequest) => {
  await requireRole("OPERATOR", "ADMIN");
  const raw = new URL(request.url).searchParams.get("status");
  const status = STATUSES.find((s) => s === raw);
  const [stats, deliveries] = await Promise.all([getDeliveryStats(24), listDeliveries({ status })]);
  return ok({ stats, deliveries });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("OPERATOR", "ADMIN");
  const { id } = await parseBody(request, z.object({ id: z.string().uuid() }));
  await requeueDelivery(id, user);
  return ok({ requeued: true });
});
