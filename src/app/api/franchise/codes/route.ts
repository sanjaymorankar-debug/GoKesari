/** POST { memberId } — the owner gives a member of his own team a tracking-only franchise code (brief §2.8). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { issueMemberFranchiseCode } from "@/server/franchise/codes";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-code:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ memberId: z.string().uuid() }));
  return ok({ code: await issueMemberFranchiseCode(user, body.memberId) }, 201);
});
