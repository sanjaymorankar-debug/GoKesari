/**
 * F6.1.3 / F6.2.3 (batch-2026-10 WS-C): cancel with the refund choice the
 * customer made on the quote. `expectedRefundPaise` is the amount they were
 * shown — the server re-checks it under the order lock and answers 409 if it
 * changed. The original PATCH /api/orders/[id]/status keeps working as before.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelOrderWithChoice } from "@/server/aftercare/cancellation";

export const dynamic = "force-dynamic";

const schema = z.object({
  reason: z.string().max(300).nullish(),
  refundMethod: z.enum(["WALLET", "ORIGINAL"]).optional(),
  expectedRefundPaise: z.number().int().min(0).optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const user = await requireUser();
  return ok(await cancelOrderWithChoice(id, user, body));
});
