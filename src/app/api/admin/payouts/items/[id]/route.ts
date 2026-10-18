/**
 * One shop's payout in a batch (PAYOUT_MANAGE): mark paid with the bank's
 * UTR, mark failed with the bank's reason, retry now, or move to the next
 * cycle (release).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { markPayoutItemFailed, markPayoutItemPaid, releasePayoutItem, retryPayoutItem } from "@/server/payouts/batches";
import { isUuid } from "@/server/payouts/http";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_paid"), utr: z.string().min(1).max(40) }),
  z.object({ action: z.literal("mark_failed"), reason: z.string().min(3).max(300) }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("release") }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PAYOUT_MANAGE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payout item");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "mark_paid":
      return ok(await markPayoutItemPaid(id, body.utr, user));
    case "mark_failed":
      return ok(await markPayoutItemFailed(id, body.reason, user));
    case "retry":
      return ok(await retryPayoutItem(id, user));
    default:
      return ok(await releasePayoutItem(id, user));
  }
});
