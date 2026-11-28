/**
 * Registration fee "Pay later" requests (0229; docs/fee-pay-later-2026-11).
 *
 * GET  ?status=REQUESTED|APPROVED|REJECTED|CANCELLED|SETTLED|ALL   → { rows, counts }
 * POST { requestId, decision: "APPROVE" | "REJECT", note? }       → { request, live, waitingFor }
 *      APPROVE: the fee no longer holds the shop back (live now when nothing else does); recovered from payouts.
 *      REJECT (note required, shown to the owner): the owner pays the fee as before.
 * Administrators only (REGISTRATION_FEE_MANAGE); every decision is audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { SHOP_FEE_PAY_LATER_STATUSES } from "@/server/db/schema";
import { decidePayLater, listPayLaterRequests } from "@/server/services/fee-pay-later";

export const dynamic = "force-dynamic";

const query = z.object({ status: z.enum([...SHOP_FEE_PAY_LATER_STATUSES, "ALL"]).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return ok(await listPayLaterRequests(params.status ?? "REQUESTED"));
});

const body = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const input = await parseBody(request, body);
  return ok(await decidePayLater(input.requestId, input.decision, input.note ?? null, { id: user.id, role: user.role }));
});
