/**
 * Owner, 28-Nov-2026: a dealer (or a shop owner who asked to become one) asks to become a super dealer.
 *   GET                  the account's state (NOT_A_DEALER, CAN_REQUEST, PENDING, AFTER_DEALER_APPROVAL, SUPER, IN_TEAM, CLOSED)
 *   POST { note? }       raise the request (an admin or operator approves it); before the dealer is approved the
 *                        wish is kept and the request follows the approval.
 * src/server/dealers/super-requests.ts.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { requestSuperDealer, superRequestState } from "@/server/dealers/super-requests";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  return ok(await superRequestState(user.id));
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`super-request:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ note: z.string().max(300).nullish() }));
  await requestSuperDealer(user, body.note ?? null);
  return ok(await superRequestState(user.id), 201);
});
