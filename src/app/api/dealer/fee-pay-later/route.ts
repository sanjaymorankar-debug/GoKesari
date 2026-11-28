/**
 * Pay-later requests of shops registered with this dealer's / franchise's codes (0229; owner, 28-Nov-2026:
 * the dealer whose referral code the shop used decides, not GoKesari's administrators).
 *
 * GET  ?status=REQUESTED|APPROVED|REJECTED|CANCELLED|SETTLED|ALL → { rows, counts } (own requests only)
 * POST { requestId, decision: "APPROVE" | "REJECT", note? }     → { request, live, waitingFor }
 * The service checks the request is this dealer's (else 403).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { SHOP_FEE_PAY_LATER_STATUSES } from "@/server/db/schema";
import { decidePayLater, listPayLaterRequests } from "@/server/services/fee-pay-later";

export const dynamic = "force-dynamic";

const query = z.object({ status: z.enum([...SHOP_FEE_PAY_LATER_STATUSES, "ALL"]).optional() });

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return ok(await listPayLaterRequests(params.status ?? "REQUESTED", { approverUserId: user.id }));
});

const body = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`dealer-fee-pay-later:${user.id}`, RATE_LIMITS.MUTATION);
  const input = await parseBody(request, body);
  return ok(await decidePayLater(input.requestId, input.decision, input.note ?? null, { id: user.id, role: user.role }));
});
