/**
 * Active shop suspensions with what happened to each open order, and the
 * operator's decision on the orders the policy held for review.
 *   GET
 *   POST { orderId, decision: "CANCEL_REFUND" | "CONTINUE", note? }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listActiveSuspensions, resolveSuspendedOrder } from "@/server/services/shop-suspension";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.SHOP_SUSPEND);
  return ok({ suspensions: await listActiveSuspensions() });
});

const schema = z.object({
  orderId: z.string().uuid(),
  decision: z.enum(["CANCEL_REFUND", "CONTINUE"]),
  note: z.string().trim().max(500).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_SUSPEND);
  const body = await parseBody(request, schema);
  await resolveSuspendedOrder(body.orderId, body.decision, body.note ?? null, user);
  return ok({ resolved: true });
});
