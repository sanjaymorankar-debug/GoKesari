/**
 * The turnover fee slabs' On/Off switch (owner, 28-Nov-2026) — always four-eye, ADMIN or OPERATOR
 * (services/turnover-fee-switch.ts).
 *
 * GET                       → { enabled, flatFeePaise, pending }
 * POST { enabled, reason? } → 202 { pendingApproval, approvalId, message }: nothing changes until a DIFFERENT admin
 *                             or operator approves it (POST /api/approvals/{id}/decide); the requester may cancel it
 *                             (POST /api/approvals/{id}/cancel).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getTurnoverSwitchState, requestTurnoverFeeSwitch, TURNOVER_SWITCH_ROLES } from "@/server/services/turnover-fee-switch";

export const dynamic = "force-dynamic";

const schema = z.object({ enabled: z.boolean(), reason: z.string().trim().max(500).nullish() });

export const GET = route(async () => {
  await requireRole(...TURNOVER_SWITCH_ROLES);
  return ok(await getTurnoverSwitchState());
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireRole(...TURNOVER_SWITCH_ROLES);
  const body = await parseBody(request, schema);
  return ok(await requestTurnoverFeeSwitch(actor, { enabled: body.enabled, reason: body.reason ?? null }), 202);
});
