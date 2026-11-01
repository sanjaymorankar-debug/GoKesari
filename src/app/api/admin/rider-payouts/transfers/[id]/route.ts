/**
 * A rider bank transfer waiting for review (FINANCE_PREPARE; docs/gig-bank-payouts-2026-10):
 *   POST { action: "retry" }            → send it again
 *   POST { action: "release", note? }   → hand the amount back to the rider's balance
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { reviewTransfer } from "@/server/rider-wallet/transfers";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.enum(["retry", "release"]), note: z.string().trim().max(300).optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_PREPARE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Transfer");
  const body = await parseBody(request, schema);
  return ok(await reviewTransfer(id, body.action, user, body.note));
});
