/** POST { version } — accept the franchise responsibilities and rules (clickwrap: version, text hash, IP, device). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { acceptFranchiseAgreement } from "@/server/franchise/booking";
import { clientIp } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-agreement:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ version: z.string().min(1).max(20) }));
  return ok(await acceptFranchiseAgreement(user, body.version, { ipAddress: clientIp(request), userAgent: request.headers.get("user-agent") }), 201);
});
